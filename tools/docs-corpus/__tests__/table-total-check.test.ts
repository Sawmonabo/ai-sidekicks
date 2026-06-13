import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { runTableTotalCheck } from "../bin/table-total-check.ts";

const GOOD = `# Doc

Total enumerated event types: **30** <!-- corpus:total-check column="Count" prose-total="Total enumerated event types" -->

| Category | Count |
| --- | --- |
| a | 12 |
| b | 18 |
| **Total** | **30** |
`;

// In-table Total row drifted to 25 while the column still sums to 30.
const BAD = GOOD.replace("| **Total** | **30** |", "| **Total** | **25** |");

function withFile(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(resolve(tmpdir(), "ttc-bin-"));
  const file = resolve(dir, "case.md");
  writeFileSync(file, content);
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

describe("table-total-check — runTableTotalCheck", () => {
  it("exits 0 with no message on a reconciling table", () => {
    withFile(GOOD, (file) => {
      expect(runTableTotalCheck([file])).toEqual({ exitCode: 0, message: "" });
    });
  });

  it("exits 1 and reports the table-total mismatch on a drifted table", () => {
    withFile(BAD, (file) => {
      const result = runTableTotalCheck([file]);
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("table-total-coherence");
      expect(result.message).toContain("Total");
    });
  });

  it("skips non-markdown and unreadable argv paths (exits 0)", () => {
    expect(runTableTotalCheck(["/nope/missing.md", "/nope/missing.txt"])).toEqual({
      exitCode: 0,
      message: "",
    });
  });
});

describe("table-total-check — bin-script direct-invocation guard", () => {
  // runTableTotalCheck is imported above, bypassing the direct-invocation guard.
  // The guard's failure mode is hostile: a regression makes the script exit 0
  // silently, indistinguishable from "every table reconciles" — exactly the
  // vacuous pass G7 exists to prevent. These spawn the script as a bin to prove
  // main() actually runs and the guard fires.
  const binPath = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/table-total-check.ts");

  function spawnOn(content: string): ReturnType<typeof spawnSync> {
    const dir = mkdtempSync(resolve(tmpdir(), "ttc-bin-spawn-"));
    const file = resolve(dir, "case.md");
    writeFileSync(file, content);
    try {
      return spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", binPath, file],
        { encoding: "utf8" },
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  }

  it("spawning the bin with a drifted table exits 1 and prints the violation", () => {
    const result = spawnOn(BAD);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("table-total-coherence");
  });

  it("spawning the bin with a reconciling table exits 0", () => {
    const result = spawnOn(GOOD);
    expect(result.status).toBe(0);
  });
});
