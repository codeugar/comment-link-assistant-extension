import { describe, expect, it, vi } from 'vitest';
import { configureSidePanel } from './side-panel';

describe('side panel runtime', () => {
  it('opens the global panel when the toolbar action is clicked', async () => {
    const setPanelBehavior = vi.fn(async () => undefined);

    await configureSidePanel({ setPanelBehavior });

    expect(setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: true,
    });
  });
});
