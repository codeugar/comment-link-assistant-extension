import { isPageCommandMessage, runPageCommand } from '@/page/command';

const listenerFlag = '__commentLinkAssistantPageCommandListener__';

export default defineContentScript({
  registration: 'runtime',
  main() {
    const scope = globalThis as typeof globalThis & Record<string, unknown>;
    if (scope[listenerFlag]) return;
    scope[listenerFlag] = true;

    chrome.runtime.onMessage.addListener(
      (message: unknown, _sender, sendResponse) => {
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
      }
    );
  },
});
