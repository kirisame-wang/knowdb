import { defineConfig } from "vite";
import { cpSync, existsSync } from "fs";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
  },
  plugins: [
    {
      name: "copy-db",
      closeBundle() {
        if (existsSync("db")) {
          cpSync("db", "dist/db", { recursive: true });
        }
      },
    },
  ],
});
