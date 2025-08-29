import {
	Directive,
	ElementRef,
	inject,
	Renderer2,
	signal,
	OnInit,
	computed,
	effect,
	input,
	output,
	afterNextRender,
	untracked,
	DestroyRef,
	Injector,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BrnDialogRef } from '@spartan-ng/brain/dialog';
// Make sure this import path is correct for your project structure
import { BrnSheet } from './brn-sheet';
import { DOCUMENT } from '@angular/common';
import { fromEvent, merge, Observable } from 'rxjs';
import { map, switchMap, takeUntil, tap, filter, scan, distinctUntilChanged } from 'rxjs/operators';

const TRANSITION_DURATION = '0.5s';
const TRANSITION_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
const VELOCITY_THRESHOLD = 0.3;
const TRANSLATE_THRESHOLD = 5; // Min distance before drag starts
const SCROLL_LOCK_TIMEOUT = 150; // ms to wait after scroll before allowing drag
const INITIAL_DRAG_DIRECTION_THRESHOLD = 5; // Min distance to check scroll prevention
const NEGLIGIBLE_MOVEMENT_THRESHOLD = TRANSLATE_THRESHOLD * 0.5; // Ignore tiny movements on pointerup
const MINIMAL_INTENTIONAL_DRAG_THRESHOLD = 10; // Min distance for drag to be considered intentional for snapping
const SNAP_AWAY_FROM_OPEN_THRESHOLD = 20; // Min distance to drag away from fully open state

const parseMargin = (value: string | null): number => (value && value.endsWith('px') ? parseFloat(value) || 0 : 0);

interface PointerMoveState {
	initialDragTranslate: number;
	startCoord: number;
	lastCoord: number;
	lastTime: number;
	currentTranslate: number;
	velocity: number;
	pointerDownEventTarget: EventTarget | null;
	preventDragUpdate: boolean; // Flag to prevent sheet dragging (allow scroll)
	pointerId: number | null;
	initialDirectionChecked: boolean; // Flag if scroll prevention check has run
}

@Directive({
	selector: '[brnSheetGesture]',
	standalone: true,
})
export class BrnSheetGestureDirective implements OnInit {
	private readonly _injector = inject(Injector);
	private readonly _elementRef = inject(ElementRef<HTMLElement>);
	private readonly _renderer = inject(Renderer2);
	private readonly _brnDialogRef = inject(BrnDialogRef);
	private readonly _document = inject(DOCUMENT);
	private readonly _destroyRef = inject(DestroyRef);

	// --- Inputs ---
	public readonly snapToSequentialPoint = input<boolean>(false);
	public readonly snapPoints = input<number[]>([]); // Snap points in pixels or fraction (0-1) of viewport
	public readonly initialSnapPoint = input<number | undefined>(undefined); // Initial snap point (pixels or fraction)
	public readonly closeThreshold = input<number>(0.25); // Fraction (0-1) of range to drag before closing is allowed
	public readonly fadeFromIndex = input<number | undefined>(undefined); // Snap index from which backdrop starts fading

	// --- Outputs ---
	public readonly dragStarted = output<void>();
	public readonly dragMoved = output<{ translate: number; progress: number }>(); // Emits current translate and fade progress
	public readonly dragEnded = output<{ targetTranslate: number }>(); // Emits the calculated target translate after drag
	public readonly snapped = output<number>(); // Emits the translate value when snapping animation finishes
	public readonly closed = output<void>(); // Emits when the sheet closes

	// --- Private Properties ---
	private readonly _overlayPaneElement: HTMLElement = this._elementRef.nativeElement; // The sheet element itself
	private _resizeObserver: ResizeObserver | null = null;
	private _transitionEndListener: (() => void) | null = null; // Cleanup function for transitionend listener
	private _backdropElement: HTMLElement | null = null; // Reference to the CDK backdrop

	// --- Signals for State Management ---
	private readonly _elementSize = signal(0); // Calculated size (height/width) of the sheet including margins
	private readonly _velocity = signal<number>(0); // Calculated pointer velocity during drag
	private readonly _lastScrollTime = signal(0); // Timestamp of the last scroll event within the sheet
	private readonly _isDragging = signal(false); // Whether the sheet is currently being dragged
	private readonly _dragTranslate = signal(0); // The current translate value during drag (updates frequently)
	private readonly _currentTargetTranslate = signal(0); // The target translate value for animation/snapping
	private readonly _initialTranslateValue = signal(0); // Translate value when pointerdown occurred

	// --- Computed Properties ---
	// Determine axis based on sheet side
	public readonly axis = computed<'x' | 'y'>(() => (this._side() === 'top' || this._side() === 'bottom' ? 'y' : 'x'));
	// Determine size property based on axis
	public readonly sizeProperty = computed<'height' | 'width'>(() => (this.axis() === 'y' ? 'height' : 'width'));
	// Determine transform property based on axis
	public readonly transformProperty = computed<'translateY' | 'translateX'>(() =>
		this.axis() === 'y' ? 'translateY' : 'translateX',
	);
	// Get viewport size based on axis
	public readonly viewportSize = computed<number>(() => {
		const win = this._document.defaultView;
		if (!win) return 0;
		return this.axis() === 'y' ? win.innerHeight : win.innerWidth;
	});
	// Convert fractional snap points to pixel values
	public readonly snapPixelSizes = computed<number[]>(() => {
		const rawSnapPoints = this.snapPoints() ?? [];
		const vpSize = this.viewportSize();
		// If viewport size isn't available yet, only use absolute pixel values
		if (vpSize === 0) {
			return rawSnapPoints.filter((snap) => snap > 1);
		}
		return rawSnapPoints
			.map((snap) => {
				if (snap > 0 && snap <= 1) return snap * vpSize; // Convert fraction to pixels
				else if (snap > 1) return snap; // Use absolute pixel value
				else return 0;
			})
			.filter((size) => size > 0); // Filter out invalid sizes
	});
	// Determine the maximum potential size (used for translate calculations)
	public readonly fullSize = computed<number>(() => {
		const elementSize = this._elementSize();
		const snapSizes = this.snapPixelSizes();
		const maxSize = Math.max(0, ...snapSizes, elementSize);
		return maxSize;
	});
	// Multiplier for translate direction based on side (-1 for bottom/right, 1 for top/left)
	private readonly _directionMultiplier = computed<1 | -1>(() => {
		return this._side() === 'top' || this._side() === 'left' ? 1 : -1;
	});
	// Minimum translate value (fully open for top/left, fully closed for bottom/right)
	public readonly minTranslate = computed<number>(() => (this._directionMultiplier() > 0 ? -this.fullSize() : 0));
	// Maximum translate value (fully closed for top/left, fully open for bottom/right)
	public readonly maxTranslate = computed<number>(() => (this._directionMultiplier() > 0 ? 0 : this.fullSize()));
	// Translate value when the sheet is considered fully open
	public readonly openTranslate = computed<number>(() =>
		this._directionMultiplier() > 0 ? this.maxTranslate() : this.minTranslate(),
	);
	// Translate value when the sheet is considered fully closed
	public readonly closedTranslate = computed<number>(() =>
		this._directionMultiplier() > 0 ? this.minTranslate() : this.maxTranslate(),
	);
	// Array of all valid translate values for snapping (including open and closed states)
	public readonly snapTranslateValues = computed<number[]>(() => {
		const fs = this.fullSize();
		const openT = this.openTranslate();
		const closedT = this.closedTranslate();

		// If size is zero, only open/closed states are possible
		if (fs <= 0) return [openT, closedT].sort((a, b) => a - b);

		const side = this._side();
		// Get unique, sorted pixel sizes from snap points that are within the full size
		const validPixelSizes = [
			...new Set(
				this.snapPixelSizes()
					.filter((p) => p > 0 && p < fs)
					.sort((a, b) => a - b),
			),
		];

		let translateValues: number[];
		// Calculate translate values based on side and pixel sizes
		if (side === 'top' || side === 'left') {
			// Translate is negative, size increases towards 0 (open)
			translateValues = [closedT, ...validPixelSizes.map((size) => -(fs - size)), openT];
		} else {
			// Translate is positive, size increases away from 0 (open)
			translateValues = [openT, ...validPixelSizes.map((size) => fs - size), closedT];
		}
		// Ensure unique values and sort numerically
		return [...new Set(translateValues)].sort((a, b) => a - b);
	});
	// Determine the initial target translate value based on input or default to open
	public readonly initialTargetTranslate = computed<number>(() => {
		const rawInitialSnap = this.initialSnapPoint();
		const openT = this.openTranslate();
		const snaps = this.snapTranslateValues();
		let initialTarget = openT; // Default to fully open
		const fs = this.fullSize();

		if (fs <= 0) return initialTarget; // Cannot snap if size is zero

		// If an initial snap point is provided and there are intermediate snaps
		if (rawInitialSnap !== undefined && snaps.length > 2) {
			let initialSnapPixelSize = 0;
			const vpSize = this.viewportSize();
			const side = this._side();

			// Convert initial snap point (fraction or pixels) to pixel size
			if (rawInitialSnap > 0 && rawInitialSnap <= 1) {
				if (vpSize > 0) {
					initialSnapPixelSize = rawInitialSnap * vpSize;
				}
			} else if (rawInitialSnap > 1) {
				initialSnapPixelSize = rawInitialSnap;
			}

			// If a valid pixel size was determined
			if (initialSnapPixelSize > 0) {
				// Calculate the theoretical translate value for this size
				const targetTranslateForCalc =
					side === 'top' || side === 'left'
						? Math.min(openT, -(fs - initialSnapPixelSize)) // Ensure it's not beyond open state
						: Math.max(openT, fs - initialSnapPixelSize); // Ensure it's not beyond open state

				// Find the closest actual snap translate value to the theoretical one
				initialTarget = snaps.reduce(
					(prev, curr) => (Math.abs(curr - targetTranslateForCalc) < Math.abs(prev - targetTranslateForCalc) ? curr : prev),
					openT, // Start comparison from open state
				);
			}
		}
		return initialTarget;
	});
	// Determine the translate value where the backdrop starts fading
	private readonly _fadeStartTranslate = computed<number>(() => {
		const snaps = this.snapTranslateValues();
		const openT = this.openTranslate();
		const index = this.fadeFromIndex();

		// If a valid index is provided, use the corresponding snap translate value
		if (index !== undefined && index >= 0 && index < snaps.length) {
			return snaps[index];
		}
		// Otherwise, start fading from the fully open state
		return openT;
	});
	// Calculate the backdrop fade progress (0 = fully faded, 1 = fully opaque)
	private readonly _dragProgress = computed(() => {
		const fadeStartT = this._fadeStartTranslate();
		const closedT = this.closedTranslate();
		// Use drag translate if dragging, otherwise use the target translate
		const currentT = this._isDragging() ? this._dragTranslate() : this._currentTargetTranslate();
		const sideMultiplier = this._directionMultiplier();

		const fadeRange = Math.abs(fadeStartT - closedT);
		if (fadeRange <= 0) return 0; // Avoid division by zero

		let distanceIntoFadeRange: number;
		// Calculate how far the current translate is into the fade range
		if (sideMultiplier > 0) { // top/left
			distanceIntoFadeRange = fadeStartT - currentT;
		} else { // bottom/right
			distanceIntoFadeRange = currentT - fadeStartT;
		}

		// Calculate progress, clamped between 0 and 1
		const progress = distanceIntoFadeRange / fadeRange;
		return Math.max(0, Math.min(1, progress));
	});

	// Inject the sheet component to access its 'side' property
	private readonly _side = inject(BrnSheet).side;

	constructor() {
		afterNextRender(
			{
				read: () => {
					// Get backdrop element after render
					this._backdropElement = this._document.querySelector('.cdk-overlay-backdrop');
					// Initialize sheet state (size, position)
					this.initializeState();
					// Observe size changes
					this.setupResizeObserver();
					// Setup effects for reacting to signal changes
					this._setupEffects(this._injector);
				},
			},
			{ injector: this._injector },
		);

		// Cleanup on destroy
		this._destroyRef.onDestroy(() => {
			this._resizeObserver?.disconnect();
			// Clean up transition listener if active
			if (this._transitionEndListener) {
				this._transitionEndListener();
				this._transitionEndListener = null;
			}
			// Reset backdrop styles
			if (this._backdropElement) {
				this._renderer.removeStyle(this._backdropElement, 'opacity');
				this._renderer.removeStyle(this._backdropElement, 'transition');
			}
			// Reset potential filter style
			this._renderer.removeStyle(this._overlayPaneElement, 'filter');
		});
	}

	ngOnInit(): void {
		// Listen for scroll events within the sheet
		this.setupScrollListener();
		// Setup the pointer event stream for dragging
		this.setupDragStream();
		// IMPORTANT: Prevent default touch actions (like scrolling) on the sheet host element.
		// This allows our pointer listeners to take control.
		// Native scrolling on child elements will be handled by the shouldPreventSheetDrag logic.
		this._renderer.setStyle(this._overlayPaneElement, 'touch-action', 'none');
	}

	// --- Initialization ---

	private initializeState(): void {
		// Read initial size including margins
		const initialReadSize =
			this.axis() === 'y' ? this._overlayPaneElement.offsetHeight : this._overlayPaneElement.offsetWidth;
		const computedStyle = window.getComputedStyle(this._overlayPaneElement);
		let marginSize = 0;

		if (this.axis() === 'y') {
			marginSize = parseMargin(computedStyle.marginTop) + parseMargin(computedStyle.marginBottom);
		} else {
			marginSize = parseMargin(computedStyle.marginLeft) + parseMargin(computedStyle.marginRight);
		}
		const totalInitialSize = initialReadSize + marginSize;
		this._elementSize.set(totalInitialSize);

		// Get calculated initial and closed translate values
		const initialTarget = this.initialTargetTranslate();
		const closedT = this.closedTranslate();
		const transformProp = this.transformProperty();

		// --- Initial Positioning ---
		// 1. Temporarily disable transitions
		this._renderer.setStyle(this._overlayPaneElement, 'transition', 'none');
		// 2. Set initial transform to the closed position (avoids flash of content)
		this._renderer.setStyle(this._overlayPaneElement, 'transform', `${transformProp}(${closedT}px)`);

		// 3. Set the target translate signal (where it should animate to)
		this._currentTargetTranslate.set(initialTarget);
		// 4. Set the drag translate signal initially to the closed position
		this._dragTranslate.set(closedT);

		// --- Initial Backdrop Opacity ---
		// Calculate initial opacity based on the target position's progress
		const initialProgress = untracked(() => { // Use untracked to read computed signals without creating dependency
			const fadeStartT = this._fadeStartTranslate();
			const fadeRange = Math.abs(fadeStartT - closedT);
			if (fadeRange <= 0) return 0;
			let distanceIntoFadeRange: number;
			if (this._directionMultiplier() > 0) {
				distanceIntoFadeRange = fadeStartT - initialTarget;
			} else {
				distanceIntoFadeRange = initialTarget - fadeStartT;
			}
			const progress = distanceIntoFadeRange / fadeRange;
			return Math.max(0, Math.min(1, progress));
		});

		if (this._backdropElement) {
			const initialOpacity = (1 - initialProgress).toFixed(6); // Opacity is inverse of progress
			this._renderer.removeStyle(this._backdropElement, 'transition'); // Disable transition for initial set
			this._renderer.setStyle(this._backdropElement, 'opacity', initialOpacity);
		}

		// --- Animate to Initial Position ---
		// Use requestAnimationFrame to ensure styles are applied before re-enabling transitions
		requestAnimationFrame(() => {
			// 5. Re-enable transitions for the sheet transform
			this._renderer.setStyle(this._overlayPaneElement, 'transition', `transform ${TRANSITION_DURATION} ${TRANSITION_EASING}`);
			// 6. Set the transform to the actual target position, triggering the animation
			this._renderer.setStyle(this._overlayPaneElement, 'transform', `${transformProp}(${initialTarget}px)`);

			// 7. Re-enable transitions for the backdrop opacity
			if (this._backdropElement) {
				this._renderer.setStyle(this._backdropElement, 'transition', `opacity ${TRANSITION_DURATION} ${TRANSITION_EASING}`);
				// Note: Opacity will animate automatically via the _dragProgress effect if needed
			}
			// 8. Listen for the end of this initial animation
			this.listenForTransitionEnd(initialTarget);
		});
	}

	private setupResizeObserver(): void {
		if (this._resizeObserver) return; // Already setup

		this._resizeObserver = new ResizeObserver((entries) => {
			if (!entries || entries.length === 0) return;
			const entry = entries[0];
			const targetElement = entry.target as HTMLElement;
			let borderBoxSizeValue: number | undefined;

			// Try to get borderBoxSize (more accurate)
			if (entry.borderBoxSize && entry.borderBoxSize.length > 0) {
				const borderBox = entry.borderBoxSize[0];
				borderBoxSizeValue = this.axis() === 'y' ? borderBox.blockSize : borderBox.inlineSize;
			}
			// Fallback to contentRect if borderBoxSize is not available
			else if (entry.contentRect) {
				borderBoxSizeValue = this.axis() === 'y' ? entry.contentRect.height : entry.contentRect.width;
			}

			if (borderBoxSizeValue === undefined) return; // Cannot determine size

			// Recalculate total size including margins
			const computedStyle = window.getComputedStyle(targetElement);
			let marginSize = 0;
			if (this.axis() === 'y') {
				marginSize = parseMargin(computedStyle.marginTop) + parseMargin(computedStyle.marginBottom);
			} else {
				marginSize = parseMargin(computedStyle.marginLeft) + parseMargin(computedStyle.marginRight);
			}
			const newTotalSize = borderBoxSizeValue + marginSize;

			// Update the element size signal if it has changed significantly
			if (newTotalSize > 0 && Math.abs(newTotalSize - this._elementSize()) > 1) {
				this._elementSize.set(newTotalSize);
				// Note: No need to manually adjust position here; computed properties
				// depending on _elementSize will update automatically.
			}
		});
		// Observe the sheet element
		this._resizeObserver.observe(this._overlayPaneElement);
	}

	// --- Effects (Reactive Updates) ---

	private _setupEffects(injector: Injector): void {
		// Effect 1: Apply drag translate directly when dragging
		effect(
			() => {
				// Only run when dragging
				if (!this._isDragging()) return;

				// Temporarily disable CSS transitions during direct manipulation
				untracked(() => this._renderer.setStyle(this._overlayPaneElement, 'transition', 'none'));

				const translate = this._dragTranslate();
				// Apply the current drag translate value directly to the element's transform style
				this._renderer.setStyle(this._overlayPaneElement, 'transform', `${this.transformProperty()}(${translate}px)`);
			},
			{ injector }, // Pass injector for context
		);

		// Effect 2: Animate to target translate when not dragging
		effect(
			() => {
				const isDragging = this._isDragging();
				const targetTranslate = this._currentTargetTranslate(); // Read the target value

				// Read necessary computed values within untracked to avoid unnecessary dependencies
				const transformProp = untracked(() => this.transformProperty());
				const closedT = untracked(() => this.closedTranslate());
				const fullSz = untracked(() => this.fullSize());
				const paneElement = this._overlayPaneElement;

				// Only run when NOT dragging
				if (!isDragging) {
					// Use rAF to ensure rendering happens after potential drag updates
					requestAnimationFrame(() => {
						// Double check if dragging started again before rAF callback
						if (this._isDragging()) return;

						// Get the current visual transform value from the element's style
						const currentVisualTransform = this.getCurrentTransform();

						// If the visual position doesn't match the target, animate
						if (Math.abs(currentVisualTransform - targetTranslate) > 0.1) {
							// Ensure CSS transitions are enabled
							this._renderer.setStyle(
								paneElement,
								'transition',
								`transform ${TRANSITION_DURATION} ${TRANSITION_EASING}`,
							);
							// Apply the target transform to trigger the animation
							this._renderer.setStyle(paneElement, 'transform', `${transformProp}(${targetTranslate}px)`);
							// Listen for the end of this animation
							this.listenForTransitionEnd(targetTranslate);
						} else {
							// Already at the target position, handle final states
							// If the target was the closed state and size is valid
							if (targetTranslate === closedT && fullSz > 0) {
								this.closed.emit(); // Emit closed event
								this._brnDialogRef.close(); // Close the dialog
							}
							// If the target was a snap point (not closed)
							else if (targetTranslate !== closedT) {
								this.snapped.emit(targetTranslate); // Emit snapped event
							}
						}
					});
				} else {
					// If dragging started, ensure any pending transitionend listener is cleaned up
					if (this._transitionEndListener) {
						this._transitionEndListener();
						this._transitionEndListener = null;
					}
				}
			},
			{ injector },
		);

		// Effect 3: Update backdrop opacity based on drag progress
		effect(
			() => {
				if (!this._backdropElement) return; // Skip if backdrop doesn't exist

				const isDragging = this._isDragging();
				const progress = this._dragProgress(); // Read the calculated progress
				const opacityValue = (1 - progress).toFixed(6); // Opacity is inverse of progress

				// Apply the calculated opacity
				this._renderer.setStyle(this._backdropElement, 'opacity', opacityValue);

				// Manage backdrop transition style
				if (isDragging) {
					// Disable transition during drag for immediate feedback
					this._renderer.removeStyle(this._backdropElement, 'transition');
				} else {
					// Ensure transition is enabled when not dragging
					const currentTransition = this._backdropElement.style.transition;
					const expectedTransition = `opacity ${TRANSITION_DURATION} ${TRANSITION_EASING}`;
					if (currentTransition !== expectedTransition) {
						this._renderer.setStyle(this._backdropElement, 'transition', expectedTransition);
					}
				}
			},
			{ injector },
		);

		// Effect 4: Set explicit height/width when using snap points
		effect(
			() => {
				const size = this.fullSize(); // Depends on elementSize and snapPixelSizes
				const prop = untracked(() => this.sizeProperty());
				const axis = untracked(() => this.axis());
				const hasSnapPoints = untracked(() => this.snapPixelSizes().length > 0);

				// Only set explicit size if there are snap points and size is calculated
				if (hasSnapPoints && size > 0) {
					// Calculate size excluding margins
					const computedStyle = window.getComputedStyle(this._overlayPaneElement);
					let marginSize = 0;
					if (axis === 'y') {
						marginSize = parseMargin(computedStyle.marginTop) + parseMargin(computedStyle.marginBottom);
					} else {
						marginSize = parseMargin(computedStyle.marginLeft) + parseMargin(computedStyle.marginRight);
					}
					const sizeWithoutMargins = Math.max(0, size - marginSize);
					// Apply the calculated size
					this._renderer.setStyle(this._overlayPaneElement, prop, `${sizeWithoutMargins}px`);
				} else {
					// Remove explicit size if no snap points or size is zero
					this._renderer.removeStyle(this._overlayPaneElement, prop);
				}
			},
			{ injector },
		);

		// Effect 5: (Optional Debug) Apply filter when dragging
		// effect(
		// 	() => {
		// 		this._renderer.removeStyle(this._overlayPaneElement, 'filter');
		// 		const isDragging = this._isDragging();
		// 		if (isDragging) {
		// 			// Example: Apply a slight brightness change when dragging
		// 			// this._renderer.setStyle(this._overlayPaneElement, 'filter', 'brightness(0.95)');
		// 		} else {
		// 			this._renderer.removeStyle(this._overlayPaneElement, 'filter');
		// 		}
		// 	},
		// 	{ injector },
		// );
	}

	// --- Event Handling ---

	private setupScrollListener(): void {
		// Listen for scroll events *within* the sheet element (capture phase)
		fromEvent(this._overlayPaneElement, 'scroll', { capture: true, passive: true })
			.pipe(takeUntilDestroyed(this._destroyRef)) // Auto-unsubscribe on destroy
			.subscribe(() => {
				// Record the time of the last scroll event
				this._lastScrollTime.set(performance.now());
			});
	}

	// Check if a scroll event occurred recently
	private checkScrollLock(): boolean {
		return performance.now() - this._lastScrollTime() < SCROLL_LOCK_TIMEOUT;
	}

	private setupDragStream(): void {
		// --- Base Observables ---
		// Listen for pointer down events on the sheet element
		const pointerDown$: Observable<PointerEvent> = fromEvent<PointerEvent>(this._elementRef.nativeElement, 'pointerdown');
		// Listen for pointer move events on the *document* (to track movement outside the sheet)
		const pointerMove$: Observable<PointerEvent> = fromEvent<PointerEvent>(this._document, 'pointermove');
		// Listen for pointer up/cancel events on the *document*
		const pointerUp$: Observable<PointerEvent> = merge(
			fromEvent<PointerEvent>(this._document, 'pointerup'),
			fromEvent<PointerEvent>(this._document, 'pointercancel'),
		);

		// --- Drag Logic Stream ---
		pointerDown$
			.pipe(
				// Filter 1: Only handle primary pointer (e.g., first finger, left mouse)
				filter((event) => event.isPrimary),
				// Filter 2: Check if dragging should be initiated based on target element and scroll lock
				filter((event) => this.shouldStartDrag(event)),
				// Side Effect 1: Prepare for potential drag start
				tap((startEvent) => {
					// !!! REMOVED event.preventDefault() from here !!!
					this.prepareDragStart(startEvent); // Record initial translate, reset velocity
					try {
						// Capture the pointer to ensure events are received even if pointer moves off the element
						(startEvent.target as HTMLElement)?.setPointerCapture(startEvent.pointerId);
					} catch (e) {
						// Ignore potential errors (e.g., element not capable of capture)
					}
				}),
				// SwitchMap: Manage the drag sequence (move -> up/cancel) for each pointerdown
				switchMap((startEvent) => {
					// --- Initialize State for this Drag Sequence ---
					const initialDragTranslate = this._initialTranslateValue(); // Get translate at pointerdown
					const startCoord = this.axis() === 'y' ? startEvent.clientY : startEvent.clientX; // Get starting coordinate
					const pointerId = startEvent.pointerId; // Store the ID of the initiating pointer

					// Seed state for the scan operator
					const seed: PointerMoveState = {
						initialDragTranslate,
						startCoord,
						lastCoord: startCoord,
						lastTime: performance.now(),
						currentTranslate: initialDragTranslate, // Start at the initial translate
						velocity: 0,
						pointerDownEventTarget: startEvent.target, // Store the element where pointerdown occurred
						preventDragUpdate: false, // Initially, allow drag updates
						pointerId: pointerId,
						initialDirectionChecked: false, // Haven't checked scroll prevention yet
					};

					// --- Process Pointer Moves ---
					return pointerMove$.pipe(
						// Filter 3: Only process moves from the initiating pointer
						filter((moveEvent) => moveEvent.pointerId === pointerId),
						// Map: Extract relevant data from the move event
						map((moveEvent) => ({
							event: moveEvent, // Keep the original event
							coord: this.axis() === 'y' ? moveEvent.clientY : moveEvent.clientX,
							time: performance.now(),
						})),
						// Scan: Accumulate state based on pointer movements
						scan((acc, current) => {
							// --- Calculate Deltas ---
							const timeDelta = current.time - acc.lastTime;
							const coordDelta = current.coord - acc.lastCoord; // Delta since last move
							const totalCoordDelta = current.coord - acc.startCoord; // Delta since pointerdown

							// --- Update Velocity ---
							let vel = acc.velocity;
							if (timeDelta > 10) { // Avoid calculating velocity on rapid, small movements
								vel = coordDelta / timeDelta;
							}

							// --- Check Scroll Prevention (Once) ---
							let preventDU = acc.preventDragUpdate;
							let directionChecked = acc.initialDirectionChecked;
							if (!preventDU && !directionChecked && Math.abs(totalCoordDelta) > INITIAL_DRAG_DIRECTION_THRESHOLD) {
								const rawDir = Math.sign(totalCoordDelta); // Direction relative to start coord
								// Check if native scroll should take precedence
								if (rawDir !== 0 && this.shouldPreventSheetDrag(acc.pointerDownEventTarget, rawDir)) {
									preventDU = true; // Mark to prevent sheet drag updates
								}
								directionChecked = true; // Mark check as done
							}

							// --- Confirm Drag Start (Once) ---
							let localIsDragging = this._isDragging(); // Read current dragging state
							let dragConfirmedThisIteration = false;
							// If not already dragging, not prevented by scroll, and threshold met
							if (!localIsDragging && !preventDU && Math.abs(totalCoordDelta) > TRANSLATE_THRESHOLD) {
								this.confirmDragStart(); // Set _isDragging signal, emit event
								localIsDragging = true; // Update local flag for this iteration
								dragConfirmedThisIteration = true;
							}

							// --- Calculate New Translate ---
							const rawT = acc.initialDragTranslate + totalCoordDelta; // Theoretical translate
							let dispT = acc.currentTranslate; // Start with previous translate

							if (preventDU) {
								// If scroll prevention is active, keep the current translate (don't move the sheet)
								// No preventDefault needed here, browser handles scroll
								dispT = acc.currentTranslate;
							} else if (localIsDragging) {
								// If dragging is active and not prevented:
								// !!! MOVED event.preventDefault() here !!!
								current.event.preventDefault(); // Prevent browser default actions (like text selection, native scroll)
								const minT = this.minTranslate();
								const maxT = this.maxTranslate();
								// Clamp the translate within bounds
								dispT = Math.max(minT, Math.min(maxT, rawT));
							} else {
								// If not dragging yet (below threshold), keep the current translate
								dispT = acc.currentTranslate;
							}

							// --- Return Updated State ---
							const newState: PointerMoveState = {
								...acc,
								lastCoord: current.coord,
								lastTime: timeDelta > 10 ? current.time : acc.lastTime, // Update time only if used for velocity
								currentTranslate: dispT,
								velocity: vel,
								preventDragUpdate: preventDU,
								initialDirectionChecked: directionChecked,
							};
							return newState;
						}, seed), // End of scan operator
						// Filter 4: Only emit distinct states relevant for updates
						distinctUntilChanged(
							(prev, curr) =>
								// Check if key properties affecting visuals or logic have changed
								prev.currentTranslate === curr.currentTranslate &&
								prev.velocity === curr.velocity &&
								prev.preventDragUpdate === curr.preventDragUpdate &&
								// Also check against the actual signal state in case it changed outside the stream
								this._isDragging() === this._isDragging(),
						),
						// Filter 5: Only proceed if dragging is active and NOT prevented by scroll
						filter(({ preventDragUpdate }) => {
							const isDragging = this._isDragging();
							return isDragging && !preventDragUpdate;
						}),
						// Side Effect 2: Update signals and emit dragMoved event
						tap(({ currentTranslate, velocity }) => {
							// This block only runs if Filter 5 passes
							this._dragTranslate.set(currentTranslate); // Update the drag translate signal
							this._velocity.set(velocity); // Update the velocity signal
							const progress = this._dragProgress(); // Recalculate progress
							this.dragMoved.emit({ translate: currentTranslate, progress: progress }); // Emit event
						}),
						// TakeUntil: Stop processing moves when pointerup/cancel occurs for this pointer
						takeUntil(
							pointerUp$.pipe(
								filter((upEvent) => upEvent.pointerId === pointerId), // Match the pointer ID
								// Side Effect 3: Handle drag end logic
								tap((event) => {
									const wasDragging = this._isDragging(); // Check if drag was active before ending
									try {
										// Release pointer capture
										const targetEl = event.target as HTMLElement | null;
										if (targetEl && typeof targetEl.releasePointerCapture === 'function') {
											// Check if the element still has capture before releasing
											if (event.type !== 'pointercancel' && targetEl.hasPointerCapture(event.pointerId)) {
												targetEl.releasePointerCapture(event.pointerId);
											}
											// Attempt release on pointercancel too, might fail but worth trying
											else if (event.type === 'pointercancel') {
												try {
													targetEl.releasePointerCapture(event.pointerId);
												} catch (releaseError) {
													/* ignore */
												}
											}
										}
									} catch (e) {
										/* ignore potential errors */
									}

									if (wasDragging) {
										// If a drag was in progress, determine the final state
										this.handleDragEnd(event);
									} else {
										// If pointerup occurred before drag threshold was met, just reset state
										this._isDragging.set(false);
										this._initialTranslateValue.set(0);
									}
								}),
							),
						), // End of takeUntil
					); // End of pointerMove$ pipe
				}), // End of switchMap
				takeUntilDestroyed(this._destroyRef), // Auto-unsubscribe stream on component destroy
			)
			.subscribe(); // Activate the stream
	}


	// Determines if a drag should be initiated based on the event target
	private shouldStartDrag(event: PointerEvent): boolean {
		const target = event.target as HTMLElement;

		// Don't start drag if a scroll happened very recently
		if (this.checkScrollLock()) {
			return false;
		}

		// Traverse up the DOM from the target element
		let element: HTMLElement | null = target;
		const hostElement = this._elementRef.nativeElement;
		while (element && element !== hostElement.parentElement) {
			// Check for explicit no-drag attribute
			if (element.hasAttribute('data-brn-no-drag')) {
				return false;
			}
			// Don't start drag on interactive elements
			const tagName = element.tagName;
			if (tagName === 'INPUT' || tagName === 'BUTTON' || tagName === 'SELECT' || tagName === 'TEXTAREA' || tagName === 'A') {
				return false;
			}
			element = element.parentElement;
		}

		// If no exclusion criteria met, allow drag start
		return true;
	}

	// Records the state just before a potential drag begins
	private prepareDragStart(_event: PointerEvent): void {
		// Store the current transform value (might be mid-animation)
		this._initialTranslateValue.set(this.getCurrentTransform());
		// Reset velocity
		this._velocity.set(0);
		// Note: _isDragging is set later in confirmDragStart if threshold is met
	}

	// Confirms that the drag threshold has been met and sets dragging state
	private confirmDragStart(): void {
		// Prevent multiple confirmations
		if (this._isDragging()) return;
		// Set the drag translate to the value recorded at pointerdown
		this._dragTranslate.set(this._initialTranslateValue());
		// Set the dragging state signal
		this._isDragging.set(true);
		// Emit the drag started event
		this.dragStarted.emit();
	}

	// Handles logic when the pointer is released after dragging
	private handleDragEnd(_event?: PointerEvent): void {
		// Read final drag state
		const currentDragTranslate = this._dragTranslate();
		const endVelocity = this._velocity();
		const initialTranslate = this._initialTranslateValue(); // Translate value when drag started
		// Calculate how far the sheet was actually dragged
		const actualTranslateDelta = Math.abs(currentDragTranslate - initialTranslate);

		// Update dragging state signal
		this._isDragging.set(false);

		let finalTargetTranslate: number;

		// --- Determine Final Position ---
		// If movement was negligible, snap back to where it started
		if (actualTranslateDelta < NEGLIGIBLE_MOVEMENT_THRESHOLD) {
			finalTargetTranslate = initialTranslate;
		}
		// If movement was minimal but not negligible, still snap back (prevents tiny drifts)
		else if (actualTranslateDelta < MINIMAL_INTENTIONAL_DRAG_THRESHOLD) {
			finalTargetTranslate = initialTranslate;
		}
		// If movement was intentional, calculate the target snap point
		else {
			finalTargetTranslate = this.determineTargetTranslate(currentDragTranslate, endVelocity, initialTranslate);
		}

		// Emit event indicating the calculated target
		this.dragEnded.emit({ targetTranslate: finalTargetTranslate });
		// Set the target translate signal, which will trigger the animation effect
		this._currentTargetTranslate.set(finalTargetTranslate);

		// Reset drag-specific state
		this._initialTranslateValue.set(0);
		this._velocity.set(0);
	}


	// Sets up a listener for the 'transitionend' event
	private listenForTransitionEnd(targetTranslate: number): void {
		// Clean up any previous listener
		if (this._transitionEndListener) {
			this._transitionEndListener();
			this._transitionEndListener = null;
		}

		const closedT = untracked(() => this.closedTranslate());
		const isClosing = targetTranslate === closedT; // Is the target the closed state?
		// Timeout slightly longer than the CSS transition duration
		const timeoutDuration = parseFloat(TRANSITION_DURATION) * 1000 + 50;
		let timeoutId: any;
		const element = this._overlayPaneElement;

		// Cleanup function to remove listener and clear timeout
		const cleanup = () => {
			clearTimeout(timeoutId);
			if (typeof removeListener === 'function') {
				removeListener(); // Call the function returned by renderer.listen
			}
			// Ensure this cleanup function reference is removed if called directly
			if (this._transitionEndListener === cleanup) {
				this._transitionEndListener = null;
			}
		};

		// The actual event listener function
		const eventListener = (event: TransitionEvent) => {
			// Ensure the transition that ended was the 'transform' on our element
			if (event.propertyName === 'transform' && event.target === element) {
				cleanup(); // Remove listener and timeout

				// Check if the targetTranslate has changed since listener was attached
				const currentTarget = untracked(() => this._currentTargetTranslate());
				if (currentTarget !== targetTranslate) {
					return; // A new animation likely started, ignore this end event
				}

				// Handle final states after animation completes
				if (isClosing && untracked(() => this.fullSize()) > 0) {
					this.closed.emit();
					this._brnDialogRef.close();
				} else if (!isClosing) {
					this.snapped.emit(targetTranslate);
				}
			}
		};

		// Attach the listener using Renderer2
		const removeListener = this._renderer.listen(element, 'transitionend', eventListener);

		// Set a fallback timeout in case transitionend doesn't fire reliably
		timeoutId = setTimeout(() => {
			cleanup(); // Remove listener

			// Check if the targetTranslate has changed since timeout was set
			const currentTarget = untracked(() => this._currentTargetTranslate());
			if (currentTarget !== targetTranslate) {
				return; // A new animation likely started
			}

			// Handle final states after timeout (same logic as in eventListener)
			if (isClosing && untracked(() => this.fullSize()) > 0) {
				this.closed.emit();
				this._brnDialogRef.close();
			} else if (!isClosing) {
				this.snapped.emit(targetTranslate);
			}
		}, timeoutDuration);

		// Store the cleanup function so it can be called if needed (e.g., if drag starts mid-transition)
		this._transitionEndListener = cleanup;
	}

	// --- Calculation Logic ---

	// Calculates the target translate value after a drag ends
	private determineTargetTranslate(currentTranslate: number, velocity: number, initialTranslate: number): number {
		const snaps = this.snapTranslateValues();
		const closedT = this.closedTranslate();
		const openT = this.openTranslate();
		const side = this._side();
		const fs = this.fullSize();
		const actualTranslateDelta = Math.abs(currentTranslate - initialTranslate);

		// Case 1: No snap points or zero size - basic open/close based on intent
		if (fs <= 0 || snaps.length < 2) {
			const intent = this.getMovementIntent(velocity, actualTranslateDelta);
			// 1 = open, -1 = close, 0 = stay
			return intent === 1 ? openT : intent === -1 ? closedT : initialTranslate;
		}

		// --- Logic with Snap Points ---
		const movementIntent = this.getMovementIntent(velocity, actualTranslateDelta);

		// Special Case: Prevent accidental closing when starting near fully open
		const openProximityThreshold = 2; // Pixels close to open state
		const startedNearOpen = Math.abs(initialTranslate - openT) < openProximityThreshold;
		if (startedNearOpen && movementIntent === -1) { // Started near open, intent is closing
			const isClosingVelocity = Math.abs(velocity) > VELOCITY_THRESHOLD * 0.75; // Check if velocity is significantly closing
			const isSignificantDrag = actualTranslateDelta >= SNAP_AWAY_FROM_OPEN_THRESHOLD; // Check if dragged far enough
			// If drag wasn't significant AND velocity wasn't strongly closing, snap back to open
			if (!isSignificantDrag && !isClosingVelocity) {
				return openT;
			}
		}

		// Special Case: If already past the closed position, usually snap to closed
		const tolerance = 1; // Allow slight overshoot
		const isAtOrPastClosed =
			side === 'top' || side === 'left'
				? currentTranslate <= closedT + tolerance // For top/left, closed is more negative
				: currentTranslate >= closedT - tolerance; // For bottom/right, closed is more positive

		if (isAtOrPastClosed) {
			// Only override snapping to closed if there's a strong opening velocity
			const isStrongOpeningVelocity = movementIntent === 1 && Math.abs(velocity) > VELOCITY_THRESHOLD * 0.75;
			if (!isStrongOpeningVelocity) {
				return closedT;
			}
			// Otherwise (strong opening velocity), let the regular snapping logic proceed
		}

		// Case 2: Snap to the next/previous sequential point
		if (this.snapToSequentialPoint()) {
			// Find the snap point closest to where the drag started
			const closestInitialSnap = snaps.reduce((p, c) =>
				Math.abs(c - initialTranslate) < Math.abs(p - initialTranslate) ? c : p,
			);
			const currentIndex = snaps.indexOf(closestInitialSnap);

			// Fallback if index not found (shouldn't happen with valid snaps)
			if (currentIndex === -1) {
				return snaps.reduce((p, c) => (Math.abs(c - currentTranslate) < Math.abs(p - currentTranslate) ? c : p));
			}

			// If intent is neutral (low velocity, small delta), snap back to the starting point
			if (movementIntent === 0 && actualTranslateDelta < MINIMAL_INTENTIONAL_DRAG_THRESHOLD) {
				return closestInitialSnap;
			}
			// If intent is neutral but drag was larger, snap to closest current position
			if (movementIntent === 0) {
				const closestCurrentSnap = snaps.reduce((p, c) => (Math.abs(c - currentTranslate) < Math.abs(p - currentTranslate) ? c : p));
				return closestCurrentSnap;
			}

			// If intent is directional, find the next snap index in that direction
			const nextIndex = this.findSequentialSnapIndex(currentIndex, movementIntent);
			return snaps[nextIndex];
		}

		// Case 3: Default - Snap based on projected position (current + velocity)
		// If intent is neutral (low velocity, small delta), snap back to the starting point
		if (movementIntent === 0 && actualTranslateDelta < MINIMAL_INTENTIONAL_DRAG_THRESHOLD) {
			const closestInitialSnap = snaps.reduce((p, c) => (Math.abs(c - initialTranslate) < Math.abs(p - initialTranslate) ? c : p));
			return closestInitialSnap;
		}

		// Project where the sheet would land based on velocity
		const projectionTime = 150; // ms into the future
		const projectedTranslate = currentTranslate + velocity * projectionTime;
		// Find the snap point closest to the projected position
		let targetSnap = snaps.reduce((p, c) => (Math.abs(c - projectedTranslate) < Math.abs(p - projectedTranslate) ? c : p));

		// --- Bias Correction (Subtle adjustment based on starting snap) ---
		// Find the snap point closest to where the drag *started*
		const closestInitialSnapBias = snaps.reduce((p, c) =>
			Math.abs(c - initialTranslate) < Math.abs(p - initialTranslate) ? c : p,
		);
		const currentIndexBias = snaps.indexOf(closestInitialSnapBias);

		// If velocity is significant and starting snap is known
		if (currentIndexBias !== -1 && Math.abs(velocity) > VELOCITY_THRESHOLD) {
			const isOpening = movementIntent === 1;
			const isClosing = movementIntent === -1;
			// Find the indices for the next snap in both directions from the start
			const targetIndexForOpen = this.findSequentialSnapIndex(currentIndexBias, 1);
			const targetIndexForClose = this.findSequentialSnapIndex(currentIndexBias, -1);

			// If intent was opening, but projection landed on the closing snap, AND
			// the opening snap is different from the start, prefer the opening snap.
			if (isOpening && targetSnap === snaps[targetIndexForClose] && targetIndexForOpen !== currentIndexBias) {
				targetSnap = snaps[targetIndexForOpen];
			}
			// If intent was closing, but projection landed on the opening snap, AND
			// the closing snap is different from the start, prefer the closing snap.
			else if (isClosing && targetSnap === snaps[targetIndexForOpen] && targetIndexForClose !== currentIndexBias) {
				targetSnap = snaps[targetIndexForClose];
			}
		}

		// --- Close Threshold Check ---
		// If the target snap is the closed state, but we haven't passed the threshold
		if (targetSnap === closedT && !isAtOrPastClosed) {
			const closeThresholdFraction = this.closeThreshold(); // User-defined threshold (0-1)
			const totalRange = Math.abs(openT - closedT);
			const closeDistanceAbsolute = totalRange * closeThresholdFraction; // Threshold in pixels

			// Calculate distance dragged from the fully open state
			let distanceFromOpen: number;
			if (this._directionMultiplier() > 0) { // top/left
				distanceFromOpen = openT - currentTranslate;
			} else { // bottom/right
				distanceFromOpen = currentTranslate - openT;
			}

			const isBeyondCloseThreshold = distanceFromOpen > closeDistanceAbsolute;

			// If intent wasn't explicitly closing AND threshold wasn't met
			if (movementIntent !== -1 && !isBeyondCloseThreshold) {
				// Find the closest snap point that ISN'T the closed state
				const nonClosedSnaps = snaps.filter((snap) => snap !== closedT);
				if (nonClosedSnaps.length > 0) {
					const closestNonClosedSnap = nonClosedSnaps.reduce((p, c) =>
						Math.abs(c - currentTranslate) < Math.abs(p - currentTranslate) ? c : p,
					);
					targetSnap = closestNonClosedSnap; // Snap to that instead
				} else {
					// If only open/closed states exist, snap back to open
					targetSnap = openT;
				}
			}
		}

		return targetSnap; // Return the finally determined target snap value
	}


	// Determines the user's intent (open: 1, close: -1, none: 0) based on velocity and distance
	private getMovementIntent(velocity: number, translateDelta: number): number {
		let rawSign = 0;
		// Prioritize velocity if significant
		if (Math.abs(velocity) > VELOCITY_THRESHOLD) {
			rawSign = Math.sign(velocity);
		}
		// Otherwise, use drag distance if intentional
		else if (Math.abs(translateDelta) > MINIMAL_INTENTIONAL_DRAG_THRESHOLD) {
			// Sign of delta needs to be interpreted based on sheet side
			// We'll adjust this using _directionMultiplier later
			const deltaSign = Math.sign(this._dragTranslate() - this._initialTranslateValue());
			rawSign = deltaSign;

		}
		// If neither velocity nor distance is significant, intent is neutral
		else {
			return 0; // Neutral intent
		}

		// Convert raw sign (based on coordinate system) to intent (open/close)
		// Example: Bottom sheet (multiplier -1)
		// - Dragging up: velocity < 0, rawSign = -1. Intent = -1 * -1 = 1 (Open)
		// - Dragging down: velocity > 0, rawSign = 1. Intent = 1 * -1 = -1 (Close)
		// Example: Top sheet (multiplier 1)
		// - Dragging up: velocity < 0, rawSign = -1. Intent = -1 * 1 = -1 (Close)
		// - Dragging down: velocity > 0, rawSign = 1. Intent = 1 * 1 = 1 (Open)
		return rawSign * this._directionMultiplier();
	}


	// Finds the index of the next snap point in a given direction (1 for open, -1 for close)
	private findSequentialSnapIndex(currentIndex: number, direction: number): number {
		const snaps = this.snapTranslateValues();
		// Handle invalid current index gracefully
		if (currentIndex < 0 || currentIndex >= snaps.length) {
			return Math.max(0, Math.min(snaps.length - 1, currentIndex));
		}
		// Calculate next index based on intent direction and sheet side multiplier
		const nextIndex = currentIndex + direction * this._directionMultiplier();
		// Clamp index within valid bounds
		return Math.max(0, Math.min(snaps.length - 1, nextIndex));
	}


	// Reads the current transform value directly from the element's style
	private getCurrentTransform(): number {
		const transform = this._overlayPaneElement.style.transform;
		// Use regex to extract the translate value
		const match = transform?.match(/(translateX|translateY)\((-?[\d.]+?)px\)/);
		return match && match[2] ? parseFloat(match[2]) : 0; // Return value or 0 if not found
	}

	/**
	 * Checks if the sheet drag should be prevented to allow native scrolling.
	 * @param targetElement The element where the pointerdown event originated.
	 * @param rawDragDirection The direction of the drag relative to screen coordinates (1 down/right, -1 up/left).
	 * @returns True if sheet drag should be prevented, false otherwise.
	 */
	private shouldPreventSheetDrag(targetElement: EventTarget | null, rawDragDirection: number): boolean {
		if (!targetElement || !(targetElement instanceof HTMLElement) || rawDragDirection === 0) {
			return false; // Cannot determine or no direction
		}

		let element: HTMLElement | null = targetElement;
		const axis = this.axis(); // 'x' or 'y'
		const tolerance = 1.5; // Small tolerance for scroll position checks
		const hostElement = this._elementRef.nativeElement; // The sheet element itself

		// Traverse up from the event target
		while (element && element !== hostElement.parentElement) {
			// Skip check if the element is the sheet host itself unless it's explicitly scrollable
			// (This prevents the host from blocking scroll if it *is* the scroll container)
			const hostStyle = window.getComputedStyle(hostElement);
			const hostScrollable = axis === 'y'
				? (hostStyle.overflowY === 'scroll' || hostStyle.overflowY === 'auto')
				: (hostStyle.overflowX === 'scroll' || hostStyle.overflowX === 'auto');

			if (element === hostElement && !hostScrollable) {
				element = element.parentElement; // Move up if host isn't the scroller
				continue;
			}

			// Check current element's scroll properties
			const style = window.getComputedStyle(element);
			const isScrollableY = (style.overflowY === 'auto' || style.overflowY === 'scroll');
			const isScrollableX = (style.overflowX === 'auto' || style.overflowX === 'scroll');

			// Check Y-axis scrolling
			if (axis === 'y' && isScrollableY && element.scrollHeight > element.clientHeight + tolerance) {
				const currentScroll = element.scrollTop;
				const maxScroll = element.scrollHeight - element.clientHeight;
				// Prevent sheet drag if dragging DOWN but element is NOT scrolled to the TOP
				if (rawDragDirection > 0 && currentScroll > tolerance) {
					return true; // Allow native scroll down
				}
				// Prevent sheet drag if dragging UP but element is NOT scrolled to the BOTTOM
				if (rawDragDirection < 0 && currentScroll < maxScroll - tolerance) {
					return true; // Allow native scroll up
				}
			}
			// Check X-axis scrolling
			else if (axis === 'x' && isScrollableX && element.scrollWidth > element.clientWidth + tolerance) {
				const currentScroll = element.scrollLeft;
				const maxScroll = element.scrollWidth - element.clientWidth;
				// Prevent sheet drag if dragging RIGHT but element is NOT scrolled to the LEFT
				if (rawDragDirection > 0 && currentScroll > tolerance) {
					return true; // Allow native scroll right
				}
				// Prevent sheet drag if dragging LEFT but element is NOT scrolled to the RIGHT
				if (rawDragDirection < 0 && currentScroll < maxScroll - tolerance) {
					return true; // Allow native scroll left
				}
			}

			// Move up to the parent element
			element = element.parentElement;
		}

		// If no scrollable ancestor prevented the drag, return false
		return false;
	}
}

