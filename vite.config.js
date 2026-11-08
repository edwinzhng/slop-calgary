import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { crossingGeneratorHashes, verifyCrossingCache } from './build/crossing-cache.mjs';
import { cityMeshTransportPlugin } from './build/mesh-transport.mjs';
import { binaryStartupAssetsPlugin, startupAssetsPlugin } from './build/startup-assets.mjs';
import { mapDataTransportPlugin } from './build/map-data-transport.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  publicDir: false,
  plugins: [
    cityMeshTransportPlugin(root),
    binaryStartupAssetsPlugin(root),
    mapDataTransportPlugin(root),
    startupAssetsPlugin(),
    {
      name: 'crossing-cache',
      async buildStart() {
        if (this.meta.watchMode) return;
        await verifyCrossingCache(root);
      },
      async transform(code, id) {
        if (id !== fileURLToPath(new URL('./app/baked-crossings.js', import.meta.url))) return;
        const hashes = await crossingGeneratorHashes(root);
        for (const file of Object.keys(hashes))
          this.addWatchFile(fileURLToPath(new URL(file, import.meta.url)));
        return {
          code: code.replaceAll('__CALGARY_CROSSING_GENERATORS__', JSON.stringify(hashes)),
          map: null,
        };
      },
    },
  ],
  build: { assetsInlineLimit: 0, chunkSizeWarningLimit: 1200, rolldownOptions: { input: 'index.html' } },
  server: { strictPort: true },
  preview: { strictPort: true },
});
