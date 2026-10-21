import { resolve } from "node:path";
import { defineConfig } from "vite";

// `base: "./"` keeps asset URLs relative so the build works from any static host sub-path
// (the live site and the /preview/<branch>/ copies).
export default defineConfig({
  base: "./",
  server: { port: 5173 },
  build: {
    // MapLibre alone is ~1 MB minified; there is nothing worth splitting out.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        front: resolve(__dirname, "index.html"), // landing page
        map: resolve(__dirname, "map.html"), // map dashboard
      },
    },
  },
});
