import { readFile } from 'node:fs/promises';
import { defineConfig, type Plugin } from 'vite';

/**
 * Rapier's compat build carries its WebAssembly inline, as base64 in its JavaScript: a third
 * bigger to download, and slower to start. In the built site it fetches the .wasm file that ships
 * beside it instead (compiled as it streams in).
 */
function rapierWasmFile(): Plugin {
  return {
    name: 'rapier-wasm-file',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!/rapier3d-compat[\\/]rapier\.mjs$/.test(id)) return null;
      const inline = /(\w+)\((\w+)\.toByteArray\("[A-Za-z0-9+/=]{100000,}"\)\.buffer\)/;
      if (!inline.test(code)) {
        this.warn('the inline WebAssembly was not found: left as it is');
        return null;
      }
      return { code: code.replace(inline, (_, init: string) => `${init}({ module_or_path: new URL("./rapier_wasm3d_bg.wasm", import.meta.url) })`), map: null };
    },
  };
}

/** The shaders go into the built site without their comments and indentation. */
function wgslMinify(): Plugin {
  return {
    name: 'wgsl-minify',
    apply: 'build',
    enforce: 'pre',
    async load(id) {
      if (!id.endsWith('.wgsl?raw')) return null;
      const source = await readFile(id.slice(0, -'?raw'.length), 'utf8');
      const code = source
        .replace(/\/\/[^\n]*/g, '') // (WGSL has no strings, so nothing else starts with //)
        .split('\n')
        .map((line) => line.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .join('\n');
      return `export default ${JSON.stringify(code)};`;
    },
  };
}

export default defineConfig({
  // Relative paths, so the built site works from any folder (or a subpath of a site).
  base: './',
  server: { port: 5173, strictPort: true },
  plugins: [rapierWasmFile(), wgslMinify()],
  // The physics engine is one big chunk of its own, loaded while the GPU starts up.
  build: { chunkSizeWarningLimit: 2500 },
});
