import { defineConfig } from "vitest/config";

/**
 * Kept separate from `vite.config.ts` so the app's build/dev configuration
 * (the React plugin, the /api proxy) stays exactly as it was. The tests here
 * exercise hooks and plain modules through `renderHook`, so they need a DOM
 * but not JSX compilation.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
