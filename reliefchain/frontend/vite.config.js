import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,          // phone on the same wifi (QR-scan demo)
    allowedHosts: true,  // accept tunnel hostnames (*.trycloudflare.com)

    // Serve the chain through the same origin as the page. One address covers
    // both, so a single tunnel shares the whole demo and there is no CORS.
    proxy: {
      "/rpc": {
        target: "http://127.0.0.1:8545",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/rpc/, "") || "/",
      },
    },
  },
});
