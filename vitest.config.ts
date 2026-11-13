import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/components/setup.ts"],
    include: ["tests/components/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    clearMocks: true,
  },
});
