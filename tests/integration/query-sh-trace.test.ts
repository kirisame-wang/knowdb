import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { rm, mkdir } from "fs/promises";
import { readFileSync, existsSync, writeFileSync, rmSync, chmodSync } from "fs";
import { join } from "path";
import { parseJsonl } from "../../src/utils.js";
import type { GapEvent, LocalCommandEvent } from "../../src/types.js";
import { FIXTURE, QUERY_SH, dbDir, runIngest } from "../helpers.js";

const DB_DIR = dbDir("db-trace-test");
const TRACES_DIR = dbDir("traces-test");
const TRACES_FILE = join(TRACES_DIR, "query-commands.jsonl");
const GAPS_DIR = dbDir("gaps-trace-test");
const GAPS_FILE = join(GAPS_DIR, "query-gaps.jsonl");

function runQuery(
  args: string[],
  extraEnv: Record<string, string> = {}
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bash", [QUERY_SH, ...args], {
    encoding: "utf-8",
    env: { ...process.env, DB_DIR, TRACES_DIR, GAPS_DIR, ...extraEnv },
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? 1,
  };
}

describe("query.sh trace recording (local sink)", () => {
  let docId: string;

  beforeAll(async () => {
    await mkdir(DB_DIR, { recursive: true });
    const r = runIngest([FIXTURE], DB_DIR);
    if (r.status !== 0) throw new Error(`ingest failed: ${r.stderr}`);
    const manifest = JSON.parse(readFileSync(join(DB_DIR, "_manifest.json"), "utf-8"));
    docId = Object.keys(manifest)[0] ?? "";
  });

  afterAll(async () => {
    await rm(DB_DIR, { recursive: true, force: true });
    await rm(TRACES_DIR, { recursive: true, force: true });
    await rm(GAPS_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(TRACES_DIR, { recursive: true, force: true });
    await rm(GAPS_DIR, { recursive: true, force: true });
  });

  it("each of the 4 subcommands appends one LocalCommandEvent line", () => {
    runQuery(["search", "Preamble"]);
    runQuery(["parent", `${DB_DIR}/${docId}/01-01.md`]);
    runQuery(["siblings", `${DB_DIR}/${docId}/01-01.md`]);
    runQuery(["expand", `${DB_DIR}/${docId}/01-01.md`, "--level", "1"]);

    const events = parseJsonl<LocalCommandEvent>(readFileSync(TRACES_FILE, "utf-8"));
    expect(events.map((e) => e.command).sort()).toEqual(["expand", "parent", "search", "siblings"]);
    for (const e of events) {
      expect(e.source).toBe("local");
      expect(e.command_id).toMatch(/^c_\d{8}_\d{3}$/);
      expect(typeof e.duration_ms).toBe("number");
      expect(e.duration_ms).toBeGreaterThanOrEqual(0);
      expect(e.exit_code).toBe(0);
      expect(Number.isNaN(Date.parse(e.timestamp))).toBe(false);
      expect(Array.isArray(e.args)).toBe(true);
    }
  });

  it("preserves args verbatim (positional + flag args)", () => {
    runQuery(["search", "Preamble"]);
    runQuery(["expand", `${DB_DIR}/${docId}/01-01.md`, "--level", "2"]);

    const events = parseJsonl<LocalCommandEvent>(readFileSync(TRACES_FILE, "utf-8"));
    const search = events.find((e) => e.command === "search")!;
    expect(search.args).toEqual(["Preamble"]);
    const expand = events.find((e) => e.command === "expand")!;
    expect(expand.args).toEqual([`${DB_DIR}/${docId}/01-01.md`, "--level", "2"]);
  });

  it("two consecutive calls have monotonic command_id sequence", () => {
    runQuery(["search", "Preamble"]);
    runQuery(["parent", `${DB_DIR}/${docId}/01-01.md`]);
    const events = parseJsonl<LocalCommandEvent>(readFileSync(TRACES_FILE, "utf-8"));
    expect(events).toHaveLength(2);
    const [a, b] = events;
    const seqA = parseInt(a!.command_id.split("_").pop()!, 10);
    const seqB = parseInt(b!.command_id.split("_").pop()!, 10);
    expect(seqB).toBe(seqA + 1);
  });

  it("round-trips args with CJK / quotes / tabs through the bash sink", () => {
    runQuery(["search", 'zz_"x"\t進階']);
    const events = parseJsonl<LocalCommandEvent>(readFileSync(TRACES_FILE, "utf-8"));
    expect(events).toHaveLength(1);
    expect(events[0]!.args).toEqual(['zz_"x"\t進階']);
  });

  describe("session_id correlator", () => {
    const SESSION_FILE = dbDir("trace-test-sid");

    afterEach(() => {
      if (existsSync(SESSION_FILE)) rmSync(SESSION_FILE);
    });

    it("omits session_id when no .session_id file is present", () => {
      runQuery(["search", "Preamble"], { SESSION_ID_FILE: SESSION_FILE });
      const events = parseJsonl<LocalCommandEvent>(readFileSync(TRACES_FILE, "utf-8"));
      expect(events[0]!.session_id).toBeUndefined();
    });

    it("reads the program-generated session_id from the .session_id file", () => {
      writeFileSync(SESSION_FILE, "sess-trace-1\n");
      runQuery(["search", "Preamble"], { SESSION_ID_FILE: SESSION_FILE });
      const events = parseJsonl<LocalCommandEvent>(readFileSync(TRACES_FILE, "utf-8"));
      expect(events[0]!.session_id).toBe("sess-trace-1");
    });

    it("shares session_id with the gap sink (cross-stream join)", () => {
      writeFileSync(SESSION_FILE, "sess-shared-1\n");
      runQuery(["search", "zzz_absent_xyz"], { SESSION_ID_FILE: SESSION_FILE });
      const traces = parseJsonl<LocalCommandEvent>(readFileSync(TRACES_FILE, "utf-8"));
      const gaps = parseJsonl<GapEvent>(readFileSync(GAPS_FILE, "utf-8"));
      expect(traces[0]!.session_id).toBe("sess-shared-1");
      expect(gaps[0]!.session_id).toBe("sess-shared-1");
    });
  });

  // T14: IO failure on the trace path must never break the subcommand. The
  // command's own contract (stdout output + exit code) wins.
  it("trace IO failure does not break the subcommand (best-effort)", () => {
    // Create traces dir as a file so mkdir fails → record_command_trace
    // can't write → silent skip.
    writeFileSync(TRACES_DIR, "blocker");
    try {
      const { status, stderr } = runQuery(["search", "Preamble"]);
      expect(status).toBe(0);
      expect(stderr).toBe("");
    } finally {
      rmSync(TRACES_DIR);
    }
  });
});
