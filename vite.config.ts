import { defineConfig } from "vite";
import { cpSync, existsSync } from "fs";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
  },
  plugins: [
    {
      // Runtime-fetched static dirs (outside the module graph, so Vite won't
      // bundle them) — copy into dist so the built app can fetch them too.
      name: "copy-static",
      closeBundle() {
        for (const dir of ["db", "benchmark"]) {
          if (existsSync(dir)) {
            cpSync(dir, `dist/${dir}`, { recursive: true });
          }
        }
      },
    },
  ],
});
