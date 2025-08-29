import { BrnSheet, BrnSheetContent, BrnSheetTrigger } from '@spartan-ng/brain/sheet';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';
import { type Meta, type StoryObj, argsToTemplate, moduleMetadata } from '@storybook/angular';
import { BrnSheetGestureDirective } from '@spartan-ng/brain/sheet';

export type SheetProps = { side: 'top' | 'bottom' | 'left' | 'right' };
const meta: Meta<SheetProps> = {
	title: 'Sheet',
	component: BrnSheet,
	tags: ['autodocs'],
	args: { side: 'left' },
	argTypes: {
		side: { control: 'select', options: ['top', 'bottom', 'left', 'right'] },
	},
	decorators: [
		moduleMetadata({
			imports: [BrnSheetTrigger, BrnSheetContent, HlmSheetImports, HlmButton, HlmInput],
		}),
	],
};

export default meta;
type Story = StoryObj<SheetProps>;

export const Default: Story = {
	render: ({ ...args }) => ({
		props: args,
		template: `
      <hlm-sheet ${argsToTemplate(args)}>
        <button id='edit-profile' variant='outline' brnSheetTrigger hlmBtn>Edit Profile</button>
        <hlm-sheet-content *brnSheetContent='let ctx'>
            <hlm-sheet-header>
             <h3 hlmSheetTitle>Edit Profile</h3>
             <p hlmSheetDescription>
               Make changes to your profile here. Click save when you're done.
             </p>
            </hlm-sheet-header>
            <div class='py-4 grid gap-4'>
              <div class='items-center grid grid-cols-4 gap-4'>
                <label hlmLabel for='name' class='text-right'>Name</label>
                <input hlmInput id='name' value='Pedro Duarte' class='col-span-3' />
              </div>
              <div class='items-center grid grid-cols-4 gap-4'>
                <label hlmLabel for='username' class='text-right'>Username</label>
                <input hlmInput id='username' value='@peduarte' class='col-span-3' />
              </div>
            </div>
            <hlm-sheet-footer>
              <button hlmBtn type='submit'>Save Changes</button>
            </hlm-sheet-footer>
        </hlm-sheet-content>
      </hlm-sheet>
    `,
	}),
};

export const GestureEnabled: Story = {
	name: 'Gesture Enabled (Default Snap)',
	render: ({ ...args }) => ({
		props: args,
		template: `
      <hlm-sheet ${argsToTemplate(args)}>
        <button variant='outline' brnSheetTrigger hlmBtn>Open Sheet</button>
        <hlm-sheet-content *brnSheetContent='let ctx' brnSheetGesture>
            <hlm-sheet-header>
             <h3 hlmSheetTitle>Draggable Sheet</h3>
             <p hlmSheetDescription>You can drag this sheet up and down (or left/right).</p>
            </hlm-sheet-header>
            <div class='py-4 grid gap-4'>
              <p>Some content inside the sheet.</p>
              <p>It will snap fully open or fully closed by default.</p>
            </div>
            <hlm-sheet-footer>
              <button hlmBtn type='submit'>Save</button>
            </hlm-sheet-footer>
        </hlm-sheet-content>
      </hlm-sheet>
    `,
	}),
	args: {
		side: 'bottom',
	},
};

export const GestureWithFractionalSnaps: Story = {
	name: 'Gesture with Fractional Snap Points',
	render: ({ ...args }) => ({
		props: {
			...args,
			sheetSnapPoints: [0.9, 0.5, 0.1],
		},
		template: `
      <hlm-sheet ${argsToTemplate(args)}>
        <button variant='outline' brnSheetTrigger hlmBtn>Open Sheet</button>
        <hlm-sheet-content *brnSheetContent='let ctx' brnSheetGesture [snapPoints]="sheetSnapPoints">
            <hlm-sheet-header>
             <h3 hlmSheetTitle>Fractional Snaps</h3>
             <p hlmSheetDescription>Snaps to 90%, 50%, and 10% of viewport height.</p>
            </hlm-sheet-header>
            <div class='py-4 grid gap-4'>
              <p>Drag to feel the different snap points.</p>
            </div>
            <hlm-sheet-footer>
              <button hlmBtn type='submit'>OK</button>
            </hlm-sheet-footer>
        </hlm-sheet-content>
      </hlm-sheet>
    `,
	}),
	args: {
		side: 'bottom',
	},
};

export const GestureWithPixelSnaps: Story = {
	name: 'Gesture with Pixel Snap Points',
	render: ({ ...args }) => ({
		props: {
			...args,
			sheetSnapPoints: [600, 400, 200],
		},
		template: `
      <hlm-sheet ${argsToTemplate(args)}>
        <button variant='outline' brnSheetTrigger hlmBtn>Open Sheet</button>
        <hlm-sheet-content *brnSheetContent='let ctx' brnSheetGesture [snapPoints]="sheetSnapPoints">
            <hlm-sheet-header>
             <h3 hlmSheetTitle>Pixel Snaps</h3>
             <p hlmSheetDescription>Snaps to 600px, 400px, and 200px heights.</p>
            </hlm-sheet-header>
            <div class='py-4 grid gap-4'>
              <p>Fixed pixel snap points.</p>
            </div>
            <hlm-sheet-footer>
              <button hlmBtn type='submit'>Done</button>
            </hlm-sheet-footer>
        </hlm-sheet-content>
      </hlm-sheet>
    `,
	}),
	args: {
		side: 'bottom',
	},
};

export const GestureWithInitialSnap: Story = {
	name: 'Gesture with Initial Snap Point',
	render: ({ ...args }) => ({
		props: {
			...args,
			sheetSnapPoints: [0.9, 0.6, 0.3],
			initialSheetSnapPoint: 0.6,
		},
		template: `
      <hlm-sheet ${argsToTemplate(args)}>
        <button variant='outline' brnSheetTrigger hlmBtn>Open Sheet</button>
        <hlm-sheet-content *brnSheetContent='let ctx'
            brnSheetGesture
            [snapPoints]="sheetSnapPoints"
            [initialSnapPoint]="initialSheetSnapPoint"
        >
            <hlm-sheet-header>
             <h3 hlmSheetTitle>Initial Snap Point</h3>
             <p hlmSheetDescription>Opens initially to the 60% snap point.</p>
            </hlm-sheet-header>
            <div class='py-4 grid gap-4'>
              <p>Content...</p>
            </div>
            <hlm-sheet-footer>
              <button hlmBtn type='submit'>Confirm</button>
            </hlm-sheet-footer>
        </hlm-sheet-content>
      </hlm-sheet>
    `,
	}),
	args: {
		side: 'bottom',
	},
};

export const GestureSequentialSnap: Story = {
	name: 'Gesture with Sequential Snapping',
	render: ({ ...args }) => ({
		props: {
			...args,
			sheetSnapPoints: [0.9, 0.6, 0.3],
			sequentialSnap: true,
		},
		template: `
      <hlm-sheet ${argsToTemplate(args)}>
        <button variant='outline' brnSheetTrigger hlmBtn>Open Sheet</button>
        <hlm-sheet-content *brnSheetContent='let ctx'
            brnSheetGesture
            [snapPoints]="sheetSnapPoints"
            [snapToSequentialPoint]="sequentialSnap"
        >
            <hlm-sheet-header>
             <h3 hlmSheetTitle>Sequential Snapping</h3>
             <p hlmSheetDescription>Dragging past a point snaps to the next one in sequence.</p>
            </hlm-sheet-header>
            <div class='py-4 grid gap-4'>
              <p>Try dragging quickly past the middle snap point.</p>
            </div>
            <hlm-sheet-footer>
              <button hlmBtn type='submit'>Next</button>
            </hlm-sheet-footer>
        </hlm-sheet-content>
      </hlm-sheet>
    `,
	}),
	args: {
		side: 'bottom',
	},
};

export const GestureCustomFade: Story = {
	name: 'Gesture with Custom Fade Start',
	render: ({ ...args }) => ({
		props: {
			...args,
			sheetSnapPoints: [0.9, 0.6, 0.3],
			fadeIndex: 2,
		},
		template: `
      <hlm-sheet ${argsToTemplate(args)}>
        <button variant='outline' brnSheetTrigger hlmBtn>Open Sheet</button>
        <hlm-sheet-content *brnSheetContent='let ctx'
            brnSheetGesture
            [snapPoints]="sheetSnapPoints"
            [fadeFromIndex]="fadeIndex"
        >
            <hlm-sheet-header>
             <h3 hlmSheetTitle>Custom Fade Start</h3>
             <p hlmSheetDescription>Backdrop starts fading from the 60% snap point downwards.</p>
            </hlm-sheet-header>
            <div class='py-4 grid gap-4'>
              <p>Notice the backdrop opacity behavior.</p>
            </div>
            <hlm-sheet-footer>
              <button hlmBtn type='submit'>Proceed</button>
            </hlm-sheet-footer>
        </hlm-sheet-content>
      </hlm-sheet>
    `,
	}),
	args: {
		side: 'bottom',
	},
};

export const GestureWithScrollableContent: Story = {
	name: 'Gesture with Scrollable Content',
	render: ({ ...args }) => ({
		props: {
			...args,
		},
		template: `
      <hlm-sheet ${argsToTemplate(args)}>
        <button variant='outline' brnSheetTrigger hlmBtn>Open Sheet</button>
        
        <hlm-sheet-content 
            *brnSheetContent='let ctx' 
            brnSheetGesture 
            [closeThreshold]="0.2" 
            class="flex flex-col max-h-96"
        > 
            <hlm-sheet-header class="flex-none">
               <h3 hlmSheetTitle>Scrollable Content</h3>
               <p hlmSheetDescription>Scroll the content area below.</p>
            </hlm-sheet-header>

            <div class="flex-1 overflow-auto space-y-1">
               <p class="border p-2">Item 1</p>
               <p class="border p-2">Item 2</p>
               <p class="border p-2">Item 3</p>
               <p class="border p-2">Item 4</p>
               <p class="border p-2">Item 5</p>
               <p class="border p-2">Item 6</p>
               <p class="border p-2">Item 7</p>
               <p class="border p-2">Item 8</p>
               <p class="border p-2">Item 9</p>
               <p class="border p-2">Item 10</p>
               <p class="border p-2">Item 11</p>
               <p class="border p-2">Item 12</p>
            </div>

            <hlm-sheet-footer class="flex-none border-t">
              <button hlmBtn type='submit'>Close</button>
            </hlm-sheet-footer>
        </hlm-sheet-content>
      </hlm-sheet>
    `,
	}),
	args: {
		side: 'bottom',
	},
};

