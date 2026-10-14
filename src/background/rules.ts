import { UNSUPPORTED_ROUTE_REGEX } from '../flow/urls';
import { log } from '../shared/log';
import { RULE_STATUS_KEY, type RuleStatus } from '../shared/settings';

export const FLOW_BLOCK_ID = 1;

/** Blocks Flow's country-block page, so the tab never loads it and the background sends it home. */
export function flowRules(on: boolean): chrome.declarativeNetRequest.Rule[] {
  if (!on) return [];
  return [
    {
      id: FLOW_BLOCK_ID,
      priority: 1,
      action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
      condition: {
        regexFilter: UNSUPPORTED_ROUTE_REGEX,
        resourceTypes: [
          'main_frame' as chrome.declarativeNetRequest.ResourceType,
          'sub_frame' as chrome.declarativeNetRequest.ResourceType,
        ],
      },
    },
  ];
}

/** Install or remove the rule. A failure is stored for the popup; the unlock works without it. */
export async function syncFlowRule(enabled: boolean): Promise<void> {
  let status: RuleStatus;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [FLOW_BLOCK_ID],
      addRules: flowRules(enabled),
    });
    status = { ok: true, updatedAt: Date.now() };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log('warn', `Google Flow route block failed: ${error}`);
    status = { ok: false, error, updatedAt: Date.now() };
  }
  await chrome.storage.local.set({ [RULE_STATUS_KEY]: status });
}
