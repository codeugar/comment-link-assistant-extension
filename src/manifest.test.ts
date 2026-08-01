import { describe, expect, it } from 'vitest';
import extensionConfig from '../wxt.config';

describe('extension surface', () => {
  it('uses the toolbar action to expose a persistent side panel', async () => {
    const manifestFactory = extensionConfig.manifest;
    if (typeof manifestFactory !== 'function') {
      throw new Error('MANIFEST_FACTORY_REQUIRED');
    }

    const manifest = await manifestFactory({} as never);

    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['sidePanel', 'tabGroups', 'unlimitedStorage'])
    );
    expect(manifest.side_panel).toEqual({ default_path: 'sidepanel.html' });
    expect(manifest.action).not.toHaveProperty('default_popup');
    expect(manifest.permissions).not.toContain('tabs');
  });
});
