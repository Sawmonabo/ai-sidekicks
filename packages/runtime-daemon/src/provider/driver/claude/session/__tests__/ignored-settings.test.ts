// `ignored-settings.ts`: the `settings_ignored` notice names the last managed file that sets the
// retention, and a managed file the daemon cannot read is told without holding the notice back.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TEST_SESSION_ID } from "../../__fixtures__/transport-doubles.js";
import { findIgnoredSettingNotice } from "../ignored-settings.js";

let managedFolder: string | undefined;

afterEach(async () => {
  if (managedFolder !== undefined) {
    await rm(managedFolder, { recursive: true, force: true });
    managedFolder = undefined;
  }
});

describe("findIgnoredSettingNotice", () => {
  it("names the last managed file that sets the retention and tells an unreadable one", async () => {
    managedFolder = await mkdtemp(path.join(os.tmpdir(), "claude-managed-"));
    const dropIns = path.join(managedFolder, "managed-settings.d");
    await mkdir(dropIns);
    await writeFile(
      path.join(managedFolder, "managed-settings.json"),
      JSON.stringify({ cleanupPeriodDays: 3 }),
    );
    await writeFile(path.join(dropIns, "10-team.json"), JSON.stringify({ cleanupPeriodDays: 7 }));
    await writeFile(path.join(dropIns, "20-other.json"), JSON.stringify({ model: "opus" }));
    // A folder named like a drop-in: reading it fails with a fault, not an absent file.
    await mkdir(path.join(dropIns, "30-folder.json"));
    const readFailures: unknown[] = [];

    const notice = await findIgnoredSettingNotice(
      TEST_SESSION_ID,
      { cleanupPeriodDays: 7 },
      managedFolder,
      (error) => readFailures.push(error),
    );

    expect(notice).toStrictEqual({
      sessionId: TEST_SESSION_ID,
      kind: "settings_ignored",
      provider: "claude",
      key: "cleanupPeriodDays",
      file: path.join(dropIns, "10-team.json"),
    });
    expect(readFailures).toHaveLength(1);
    expect(readFailures[0]).toMatchObject({ code: "EISDIR" });
  });
});
