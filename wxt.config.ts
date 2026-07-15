import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  entrypointsDir: '../entrypoints',
  outDir: '.output',
  modules: ['@wxt-dev/module-react'],
  manifest: () => ({
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    version: '0.3.3',
    default_locale: 'en',
    action: {
      default_title: '__MSG_extensionName__',
    },
    permissions: ['storage', 'activeTab', 'scripting', 'alarms'],
    host_permissions: ['https://api.deepseek.com/*', 'https://api.kie.ai/*'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
  }),
});
