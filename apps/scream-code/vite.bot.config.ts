import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The bot workbench's own Vite app.
 *
 * `root` is the UI itself rather than the package, so `index.html` and the `@` alias sit where the
 * components expect them. The build lands in the package's `dist/bot-ui`, which is what the gateway
 * serves.
 */
const root = fileURLToPath(new URL("./src/bot/ui", import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": root,
    },
  },
  server: {
    port: 5174,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://localhost:3210",
        changeOrigin: true,
      },
    },
  },
  build: {
    // Not `../../dist/bot-ui`: outDir is resolved from `root`, which is `src/bot/ui`.
    outDir: fileURLToPath(new URL("./dist/bot-ui", import.meta.url)),
    emptyOutDir: true,
  },
});
