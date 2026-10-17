export async function dispatchAfterRouterConfirmation(
  skipConfirmation: boolean,
  ask: () => Promise<boolean>,
  dispatch: () => Promise<void>,
): Promise<boolean> {
  if (!skipConfirmation && !(await ask())) return false;
  await dispatch();
  return true;
}
