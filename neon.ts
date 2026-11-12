import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  auth: true,
  functions: {
    guestapi: {
      name: "guest list api",
      source: "api/index.ts",
    },
  },
});
