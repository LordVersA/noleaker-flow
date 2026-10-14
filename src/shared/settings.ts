// The one setting, plus the rule status the popup shows. chrome.storage.local, nothing synced.

export const ENABLED_KEY = 'enabled';
export const RULE_STATUS_KEY = 'ruleStatus';

/** Outcome of installing the country-page block rule. */
export interface RuleStatus {
  ok: boolean;
  error?: string;
  updatedAt: number;
}

/** The unlock is on unless the user turned it off. */
export async function isEnabled(): Promise<boolean> {
  return (await chrome.storage.local.get(ENABLED_KEY))[ENABLED_KEY] !== false;
}

export async function setEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
}
