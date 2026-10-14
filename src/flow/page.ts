// Entry of the page script, built to dist/<target>/content/flow.js and run in the page's MAIN world.
// The background registers it for Flow pages only while the switch is on, so with the switch off
// none of this code exists in the page.
import { installFlowFreeze } from './freeze';
import { installFlowUnlock } from './unlock';

const unlock = installFlowUnlock(globalThis);
installFlowFreeze(globalThis, unlock.patched);
