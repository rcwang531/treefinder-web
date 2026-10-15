import { defineConfig } from "vite";

// `base: "./"` keeps asset URLs relative so the build works from any static host sub-path.
export default defineConfig({
  base: "./",
  server: { port: 5173 },
  // MapLibre alone is ~1 MB minified; there is nothing worth splitting out.
  build: { chunkSizeWarningLimit: 1500 },
});
