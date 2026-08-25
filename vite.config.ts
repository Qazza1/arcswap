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
  css: {
    // PostCSS picks up tailwind via postcss.config.js automatically
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        main:      resolve(__dirname, "index.html"),
        app:       resolve(__dirname, "app.html"),
        trade:     resolve(__dirname, "trade.html"),
        multisend: resolve(__dirname, "multisend.html"),
        pay:       resolve(__dirname, "pay.html"),
        invoice:   resolve(__dirname, "invoice.html"),
        invoices:  resolve(__dirname, "invoices.html"),
        history:   resolve(__dirname, "history.html"),
        agent:     resolve(__dirname, "agent.html"),
        analytics: resolve(__dirname, "analytics.html"),
        docs:        resolve(__dirname, "docs.html"),
        developers:  resolve(__dirname, "developers.html"),
        pricing:     resolve(__dirname, "pricing.html"),
        security:  resolve(__dirname, "security.html"),
        ecosystem: resolve(__dirname, "ecosystem.html"),
        "docs-api": resolve(__dirname, "docs-api.html"),
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
