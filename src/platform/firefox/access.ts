import { FLOW_MATCHES } from '../../flow/urls';

// Firefox MV3 treats host permissions as optional: the user can withhold or revoke them, and
// without them the registered page script and the bounce do nothing.
const ORIGINS = { origins: FLOW_MATCHES };

export async function hasFlowAccess(): Promise<boolean> {
  return chrome.permissions.contains(ORIGINS);
}

/** Must be called from a user gesture (popup click). */
export async function requestFlowAccess(): Promise<boolean> {
  return chrome.permissions.request(ORIGINS);
}
