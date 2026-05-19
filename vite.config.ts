import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { resolve } from "path";

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ["buffer", "process"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        main:      resolve(__dirname, "index.html"),
        multisend: resolve(__dirname, "multisend.html"),
      },
    },
  },
  server: {
    proxy: {
      "/circle-proxy": {
        target: "https://api.circle.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/circle-proxy/, ""),
      },
    },
  },
});
