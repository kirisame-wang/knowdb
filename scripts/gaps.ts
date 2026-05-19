import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseJsonl } from "../src/utils.js";
import { aggregate } from "../src/gaps.js";
import type { GapEvent } from "../src/types.js";

// Local analysis path. Reuses the tested aggregate() rather than
// re-implementing JSON aggregation in bash (mirrors scripts/ingest.ts tsx).
const GAPS_DIR = process.env["GAPS_DIR"] ?? "gaps";
const GAPS_FILE = join(GAPS_DIR, "query-gaps.jsonl");

function main(): void {
  const cmd = process.argv[2];
  if (cmd !== "aggregate") {
    console.error("Usage: gaps.ts aggregate");
    process.exit(1);
  }
  const text = existsSync(GAPS_FILE) ? readFileSync(GAPS_FILE, "utf-8") : "";
  const result = aggregate(parseJsonl<GapEvent>(text));
  console.log(JSON.stringify(result, null, 2));
}

main();
