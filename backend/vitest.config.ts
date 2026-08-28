import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // Password hashing at the production work factor costs hundreds of
      // milliseconds per account, and this suite creates many. The hashing
      // behaviour under test is identical at any cost factor, so the suite
      // uses a cheap one. Never lower it outside tests.
      BCRYPT_ROUNDS: "4",
    },
  },
});
