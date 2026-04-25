import { defineConfig } from "vite";

export default defineConfig({
  publicDir: "db",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: "index.html",
    },
  },
});
