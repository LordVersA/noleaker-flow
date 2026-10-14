/** Chrome grants manifest host permissions at install. */
export async function hasFlowAccess(): Promise<boolean> {
  return true;
}

export async function requestFlowAccess(): Promise<boolean> {
  return true;
}
