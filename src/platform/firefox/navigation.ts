/**
 * Firefox reports a navigation stopped by a DNR block rule with an NS_ERROR_* code that is not
 * documented. The caller only acts on the country-page URL and bounces are rate limited, so any
 * error on that page counts.
 */
export function isBlockedNavigationError(_error: string): boolean {
  return true;
}
