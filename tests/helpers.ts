import { spawnSync } from "child_process";
import { join } from "path";
import { fileURLToPath } from "url";

const HERE = fileURLToPath(new URL(".", import.meta.url)); // tests/

export const FIXTURE = join(HERE, "fixtures/sample.md");
export const QUERY_SH = join(HERE, "../scripts/query.sh");

// Per-test-file DB dir, kept distinct so parallel suites don't clobber each other.
export const dbDir = (name: string): string => join(HERE, "..", name);

// Run scripts/ingest.ts via the current node + tsx (avoids npx resolution).
// Returns the raw result; the caller decides whether non-zero status is fatal.
export function runIngest(
  args: string[],
  db: string
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", join(HERE, "../scripts/ingest.ts"), ...args],
    { encoding: "utf-8", env: { ...process.env, DB_DIR: db } }
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}
