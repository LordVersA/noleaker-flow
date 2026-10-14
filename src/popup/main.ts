import { hasFlowAccess, requestFlowAccess } from '@platform/access';
import { isEnabled, RULE_STATUS_KEY, setEnabled, type RuleStatus } from '../shared/settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

async function render(): Promise<void> {
  const enabled = await isEnabled();
  $<HTMLInputElement>('toggle').checked = enabled;
  $('sub').textContent = enabled ? 'On for Flow pages' : 'Off: no Flow code is loaded';
  $('access').hidden = !enabled || (await hasFlowAccess());
  const status = (await chrome.storage.local.get(RULE_STATUS_KEY))[RULE_STATUS_KEY] as
    RuleStatus | undefined;
  const rule = $('rule');
  rule.hidden = !enabled || !status || status.ok;
  rule.textContent = `The country-page block could not be installed (${status?.error ?? 'unknown error'}). The unlock still works, but Flow may flash its error page.`;
}

$('toggle').addEventListener('change', () => {
  void setEnabled($<HTMLInputElement>('toggle').checked);
});
$('grant').addEventListener('click', () => {
  void requestFlowAccess().then(render);
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') void render();
});
void render();
