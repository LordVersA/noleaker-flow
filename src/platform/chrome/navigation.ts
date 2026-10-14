/** Chrome reports a navigation stopped by a DNR block rule as ERR_BLOCKED_BY_CLIENT. */
export function isBlockedNavigationError(error: string): boolean {
  return error.includes('ERR_BLOCKED_BY_CLIENT');
}
