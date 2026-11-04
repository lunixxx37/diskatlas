// Entry point: self-hosted fonts, styles, and the application shell.
import '@fontsource-variable/schibsted-grotesk/wght.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/index.css';

import type { ScanTree } from './core';
import { App } from './ui/app';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('#app is missing from index.html');

const app = new App(root);
app.start();

// Development hooks for tests and screenshots (not part of production builds).
if (import.meta.env.DEV) {
  Object.assign(window, {
    __app: {
      showTree: (tree: ScanTree) => app.showTree(tree),
      scanHandle: (handle: FileSystemDirectoryHandle) => app.scanHandle(handle),
    },
  });
}
