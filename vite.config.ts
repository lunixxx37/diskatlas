import { defineConfig, type Plugin } from 'vite';

// Production builds get a strict Content Security Policy: the page may only load
// and talk to its own origin, so no scan data can leave the user's machine.
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' },
    ],
  };
}

export default defineConfig({
  // Relative asset paths, so the build also works from a sub path (e.g. GitHub Pages).
  base: './',
  plugins: [contentSecurityPolicy()],
  server: { port: 5173, strictPort: true },
  worker: { format: 'es' },
});
