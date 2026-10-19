import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Relative asset URLs. The site is served from ankiengine.com, at the
  // origin root, where Vite's default `base: '/'` would work; './' is kept
  // because it is right at any base. The build was first served from a
  // subpath of github.io, where /assets/... URLs 404 -- including the worker
  // chunk and the sql.js wasm, which fail silently and leave a dead page --
  // and a preview from a folder or another host would break the same way.
  base: './',

  // Two pages: the download page at /, the browser tool at /tool/.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2023',
    rollupOptions: {
      input: { download: here('index.html'), tool: here('tool/index.html') },
    },
  },
  server: {
    // The engine's compiled dist/ sits above this project's root. The build
    // resolves it as an ordinary relative import; the dev server needs to be
    // told it may serve from there.
    fs: { allow: ['..'] },
  },
  worker: { format: 'es' },
});
