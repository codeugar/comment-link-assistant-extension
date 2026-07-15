import { describe, expect, it, vi } from 'vitest';
import { installPageCommandListener } from './page-command-listener';

describe('page command listener', () => {
  it('replaces a stale listener left behind by an extension reload', () => {
    const staleListener = vi.fn();
    const scope: Record<string, unknown> = {
      __commentLinkAssistantPageCommandListener__: staleListener,
    };
    const addListener = vi.fn();
    const removeListener = vi.fn();

    installPageCommandListener(scope, { addListener, removeListener });

    expect(removeListener).toHaveBeenCalledWith(staleListener);
    expect(addListener).toHaveBeenCalledOnce();
    expect(scope.__commentLinkAssistantPageCommandListener__).toBe(
      addListener.mock.calls[0]?.[0]
    );
  });
});
