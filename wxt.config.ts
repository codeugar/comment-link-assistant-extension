import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  entrypointsDir: '../entrypoints',
  outDir: '.output',
  modules: ['@wxt-dev/module-react'],
  manifest: () => ({
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    // Pins the extension ID to gmdfkglpanbbilahmjfhmekegphloicl no matter
    // which folder the unpacked build is loaded from, so chrome.storage and
    // IndexedDB survive reinstalls and updates. This is the public half of a
    // throwaway keypair; the private key is not needed for unpacked loading.
    // Remove this field if the extension is ever published to the Chrome Web
    // Store (the store assigns its own key).
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA46HqD4oyxWfK3T2Nz+B3Hd1WBzKxjA0gaWB2yLBDIgB5K+XTKIEOjokLxJsddSAubJrUaySqUQ/mjE4/93aissKaRpr4WWtIhxwxnU5x4MJVcun6HvuSDBm5QHVxMpbNVYpZ586avuDUv/rBhgSgN+estz9XJWeAcqRFXpuVrvx4h6V+hyZUkQ+g9ApTHPtKcazBR9q5TN/NH5MlbZWYo9TpIGZ8qTsSpJcH3Io6+2LdkMVvIa2vr/9PDmoVtKzvIWkS0bRHhu7npGhaju9SUIWA1YRGJqVHGVNMTv/djGnsVLFaZ01rAGOtVgdw+U6u/fKcZXR3YGAt4f5J2dneQwIDAQAB',
    default_locale: 'zh_CN',
    action: {
      default_title: '__MSG_extensionName__',
    },
    permissions: [
      'storage',
      'unlimitedStorage',
      'activeTab',
      'scripting',
      'alarms',
      'sidePanel',
      'tabGroups',
      'webNavigation',
    ],
    side_panel: {
      default_path: 'sidepanel.html',
    },
    host_permissions: ['https://api.deepseek.com/*', 'https://api.kie.ai/*'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
  }),
});
