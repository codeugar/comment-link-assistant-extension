import { isPageCommandMessage, runPageCommand } from '@/page/command';

const listenerKey = '__commentLinkAssistantPageCommandListener__';
type RuntimeMessageListener = Parameters<
  typeof chrome.runtime.onMessage.addListener
>[0];

export function installPageCommandListener(
  scope: Record<string, unknown> = globalThis as Record<string, unknown>,
  onMessage: Pick<
    typeof chrome.runtime.onMessage,
    'addListener' | 'removeListener'
  > = chrome.runtime.onMessage
): void {
  const previous = scope[listenerKey];
  if (typeof previous === 'function') {
    onMessage.removeListener(previous as RuntimeMessageListener);
  }

  const listener: RuntimeMessageListener = (
    message: unknown,
    _sender,
    sendResponse
  ) => {
    if (!isPageCommandMessage(message)) return false;

    void runPageCommand(document, message.command)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          type: 'error',
          message:
            error instanceof Error ? error.message : 'PAGE_COMMAND_FAILED',
        });
      });
    return true;
  };

  scope[listenerKey] = listener;
  onMessage.addListener(listener);
}
