import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ["buffer", "process"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  build: { target: "esnext" },
  server: {
    proxy: {
      // Proxy Circle API calls through Vite to avoid CORS in development.
      // The App Kit calls https://api.circle.com — we intercept via fetch
      // patch in index.html and redirect to /circle-proxy, which Vite
      // forwards to api.circle.com server-side (no CORS restriction).
      "/circle-proxy": {
        target: "https://api.circle.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/circle-proxy/, ""),
      },
    },
  },
});
