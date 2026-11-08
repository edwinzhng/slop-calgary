import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { crossingBytePlanes } from '../app/asset-bytes.js';

const STARTUP_ASSETS = ['data/calgary.json'];

export function emitCompressedAsset(plugin, name, originalFileName, bytes) {
  const source = gzipSync(bytes, { level: 9 });
  if (!gunzipSync(source).equals(Buffer.from(bytes))) throw new Error(`Asset compression failed: ${name}`);
  // A payload file, independent of the host's HTTP Content-Encoding handling.
  const reference = plugin.emitFile({ type: 'asset', name: `${name}.cgz`, originalFileName, source });
  return `new URL(import.meta.ROLLUP_FILE_URL_${reference}, import.meta.url)`;
}

const BINARY_ASSETS = [
  ['baked-crossings', 'data/calgary-mapped-crossings.bin'],
  ['island-terrain', 'data/calgary-island-relief.bin'],
  ['neighbourhood-terrain', 'data/calgary-neighbourhood-terrain.bin'],
];

export function binaryStartupAssetsPlugin(root) {
  return {
    name: 'binary-startup-assets',
    apply: 'build',
    async transform(code, id) {
      const entry = BINARY_ASSETS.find(([module]) => id === join(root, `app/${module}.js`));
      if (!entry) return;
      const [, source] = entry;
      const path = join(root, source);
      const url = `new URL('../${source}', import.meta.url)`;
      if (!code.includes(url)) throw new Error(`Binary asset URL could not be transformed: ${source}`);
      this.addWatchFile(path);
      let bytes = await readFile(path);
      if (entry[0] === 'baked-crossings') {
        const manifestPath = join(root, 'data/calgary-mapped-crossings.json');
        this.addWatchFile(manifestPath);
        const { layout } = JSON.parse(await readFile(manifestPath, 'utf8'));
        const packed = crossingBytePlanes(bytes, layout);
        if (!bytes.equals(crossingBytePlanes(packed, layout, true)))
          throw new Error('Crossing transport failed its lossless build check');
        bytes = packed;
      }
      const emitted = emitCompressedAsset(this, source.split('/').at(-1), source, bytes);
      return { code: code.replace(url, emitted), map: null };
    },
  };
}

/** Start required downloads while the browser loads and parses the game module. */
export function startupAssetsPlugin() {
  let base;
  return {
    name: 'startup-assets',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, { bundle }) {
        if (!bundle) return;
        const assets = Object.values(bundle).filter((item) => item.type === 'asset');
        return STARTUP_ASSETS.map((source) => {
          const asset = assets.find((item) => item.originalFileNames.includes(source));
          if (!asset) throw new Error(`Required startup asset was not emitted: ${source}`);
          return {
            tag: 'link',
            attrs: {
              rel: 'preload',
              as: 'fetch',
              href: base + asset.fileName,
              crossorigin: 'anonymous',
              fetchpriority: 'low',
            },
            injectTo: 'head',
          };
        });
      },
    },
  };
}
