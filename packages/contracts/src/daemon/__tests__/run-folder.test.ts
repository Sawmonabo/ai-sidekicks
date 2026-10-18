// Desktop main and the Rust daemon resolve the run folder from one shared case table, so the two
// cannot drift into looking for the socket in different folders.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDaemonRunFolder } from "../run-folder.js";

interface RunFolderCase {
  readonly case: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly userId: number;
  readonly folderPath: string;
}

const CASES = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "../../../../../crates/sidekicks-contracts/tests/fixtures/run-folder.json",
    ),
    "utf8",
  ),
) as readonly RunFolderCase[];

// The variables either resolver reads; each case sets its own and unsets the rest.
const READ_VARIABLES = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"] as const;

describe.skipIf(process.platform === "win32")("the run folder", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(CASES.map((runFolderCase) => [runFolderCase.case, runFolderCase] as const))(
    "resolves the shared case: %s",
    (_name, runFolderCase) => {
      for (const variable of READ_VARIABLES) {
        vi.stubEnv(variable, runFolderCase.environment[variable]);
      }

      const resolved = resolveDaemonRunFolder({
        runtimeDirectory: process.env["XDG_RUNTIME_DIR"],
        temporaryDirectory: tmpdir(),
        userId: runFolderCase.userId,
      });

      expect(resolved.folderPath).toBe(runFolderCase.folderPath);
    },
  );
});
