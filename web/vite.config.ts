import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The FastAPI app registers its routes at the root (`/runs`, `/approvals`), not under a prefix, so
// the console reaches it through `/api` and the proxy STRIPS that prefix. docker/web/Caddyfile does
// the same with `handle_path`; if the two ever disagree every request 404s in exactly one of the
// dev and built environments.
const apiTarget = process.env["FOUNDRY_API_URL"] ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
