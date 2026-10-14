import { ENABLED_KEY, isEnabled } from '../shared/settings';
import { listenForFlowBounce, syncFlowScript } from './flow';
import { syncFlowRule } from './rules';

let chain: Promise<unknown> = Promise.resolve();

/** Make the registered script and the network rule match the switch, one sync at a time. */
function sync(): void {
  chain = chain.then(async () => {
    const enabled = await isEnabled();
    await syncFlowScript(enabled);
    await syncFlowRule(enabled);
  });
  chain = chain.catch(() => undefined);
}

listenForFlowBounce();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ENABLED_KEY in changes) sync();
});
// Every background start (install, update, browser start, wake) re-checks both.
sync();
