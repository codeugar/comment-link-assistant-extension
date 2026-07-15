import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vitest/config';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';

const aliasOverride: Plugin = {
  name: 'comment-link-assistant-extension:alias-override',
  enforce: 'post',
  config: () => ({
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  }),
};

export default defineConfig({
  plugins: [WxtVitest(), aliasOverride],
  test: {
    environment: 'happy-dom',
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'entrypoints/**/*.test.ts',
      'entrypoints/**/*.test.tsx',
    ],
  },
});
