import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // En dev, l'API tourne sur l'interface privée du serveur Rust (BKS_API pour une instance de test).
      "/api": {
        target: process.env.BKS_API ?? "http://127.0.0.1:9890",
        changeOrigin: true,
        // Le serveur refuse les Origin inconnues : le proxy est un intermédiaire de confiance.
        configure: (proxy) => proxy.on("proxyReq", (req) => req.removeHeader("origin")),
      },
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1200,
  },
});
