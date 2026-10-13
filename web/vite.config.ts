import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = process.env.LIGHT_SERVER ?? "http://127.0.0.1:8790";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/ws": { target, ws: true },
      "/api": target,
      "/health": target,
      "/mcp": target,
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
