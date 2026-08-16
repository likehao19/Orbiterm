import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), "index.html"),
        viewer: resolve(process.cwd(), "viewer.html"),
      },
    },
  },
});
