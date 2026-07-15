import { installPageCommandListener } from '@/runtime/page-command-listener';

export default defineContentScript({
  registration: 'runtime',
  main() {
    installPageCommandListener();
  },
});
