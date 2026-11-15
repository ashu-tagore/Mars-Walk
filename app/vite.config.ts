import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages serves the site under /<repo-name>/. The deploy workflow sets VITE_BASE to that path.
const base = process.env.VITE_BASE ?? "/";

// Largest site file is elevation.bin (4 MB). Workbox skips anything above this limit, which would break offline use.
const MAX_PRECACHE_FILE_BYTES = 8 * 1024 * 1024;

export default defineConfig({
  base,
  // The engine worker is imported from ../engine/src, outside the app root.
  server: { fs: { allow: [".."] } },
  worker: { format: "es" },
  plugins: [
    // Service worker that precaches the app and the whole site folder (tiles, overlays, .bin layers),
    // so the page keeps working with the network off after the first load.
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: null,
      manifest: false,
      workbox: {
        globPatterns: ["**/*.{html,js,css,json,bin,png,jpg,svg,woff2}"],
        maximumFileSizeToCacheInBytes: MAX_PRECACHE_FILE_BYTES,
      },
    }),
  ],
  test: { include: ["src/**/*.test.ts"] },
});
