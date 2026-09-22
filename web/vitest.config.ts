import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Deliberately not vite.config.ts: tests must not load the Tailwind plugin or the dev proxy.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    restoreMocks: true,
  },
});
