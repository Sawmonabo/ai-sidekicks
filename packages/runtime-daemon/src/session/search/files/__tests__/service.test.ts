// The `@` file search over a real folder on disk: what it keeps, what it drops, and how a failed
// read reaches the caller.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runGitWithExecFile, type GitCommand } from "../../../../git/process.js";
import { SessionNotFoundError } from "../../../../ipc/session-errors.js";
import { openDatabase } from "../../../migration-runner.js";
import { insertSession, sessionIdOf } from "../../__fixtures__/index-rows.js";
import { listWorkingFolder } from "../listing.js";
import { FileSearchService } from "../service.js";

const TIMESTAMP = "2026-10-06T00:00:00.000Z";
const gitCommand: GitCommand = (argv) => runGitWithExecFile(argv, { timeoutMs: 10_000 });

describe("session.fileSearch", () => {
  let scratch: string;
  let workingFolder: string;
  let outside: string;
  let database: Database;
  const sessionId = sessionIdOf(1);

  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "file-search-")));
    workingFolder = join(scratch, "project");
    outside = join(scratch, "outside");
    await mkdir(join(workingFolder, "src"), { recursive: true });
    await mkdir(join(workingFolder, "billing"));
    await writeFile(join(workingFolder, "billing", "readme.md"), "");
    await mkdir(outside);
    await writeFile(join(workingFolder, "src", "billing.ts"), "");
    await writeFile(join(workingFolder, "billing-notes.md"), "");
    await writeFile(join(outside, "billing-secret.txt"), "");
    // One link out of the folder to a file, one to a folder, and one that stays inside.
    await symlink(join(outside, "billing-secret.txt"), join(workingFolder, "billing-link.txt"));
    await symlink(outside, join(workingFolder, "billing-dir"));
    await symlink(
      join(workingFolder, "src", "billing.ts"),
      join(workingFolder, "billing-alias.ts"),
    );

    database = openDatabase(":memory:");
    insertSession(database, sessionId);
    database
      .prepare(
        `INSERT INTO repo_mounts (id, node_id, local_path, canonical_root, attached_at, updated_at)
         VALUES ('mount-1', 'node-1', ?, ?, ?, ?)`,
      )
      .run(workingFolder, workingFolder, TIMESTAMP, TIMESTAMP);
    database
      .prepare(
        `INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, state,
                                 created_at, updated_at)
         VALUES ('workspace-1', ?, 'mount-1', 'bound-root', ?, 'ready', ?, ?)`,
      )
      .run(sessionId, workingFolder, TIMESTAMP, TIMESTAMP);
  });

  afterEach(async () => {
    database.close();
    await rm(scratch, { recursive: true, force: true });
  });

  it.each([
    ["inside a git working tree", true],
    ["outside git", false],
  ])("never answers a path through a link out of the folder, %s", async (_label, isGit) => {
    if (isGit) {
      await gitCommand(["-C", workingFolder, "init", "--quiet"]);
    }
    const fileSearch = new FileSearchService({ reader: database, git: gitCommand });

    const response = await fileSearch.search({ sessionId, query: "billing" });

    // A match on the file's own name outranks a match on its path alone.
    expect(response.paths.at(-1)).toBe("billing/readme.md");
    expect([...response.paths].sort()).toEqual([
      "billing-alias.ts",
      "billing-notes.md",
      "billing/readme.md",
      "src/billing.ts",
    ]);
    expect(response.searchedFileCount).toBeGreaterThanOrEqual(response.paths.length);
  });

  it("refuses an unknown session, and fails rather than answering empty with no folder", async () => {
    const fileSearch = new FileSearchService({ reader: database, git: gitCommand });

    await expect(fileSearch.search({ sessionId: sessionIdOf(9), query: "" })).rejects.toThrow(
      SessionNotFoundError,
    );
    database.prepare("UPDATE workspaces SET state = 'preparing', fs_root = NULL").run();
    await expect(fileSearch.search({ sessionId, query: "" })).rejects.toThrow(/not in place/);
  });
});

describe("listWorkingFolder", () => {
  const busy = Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" });

  it("tries a retryable read once more and answers its listing", async () => {
    const git = vi
      .fn<GitCommand>()
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce({ stdout: Buffer.from("a.ts\0b.ts\0"), stderr: "" });

    await expect(listWorkingFolder("/work", git)).resolves.toEqual(["a.ts", "b.ts"]);
    expect(git).toHaveBeenCalledTimes(2);
  });

  it("surfaces a second retryable failure as the failed read, and retries no other", async () => {
    const twiceBusy = vi.fn<GitCommand>().mockRejectedValue(busy);
    await expect(listWorkingFolder("/work", twiceBusy)).rejects.toBe(busy);
    expect(twiceBusy).toHaveBeenCalledTimes(2);

    const corrupt = Object.assign(new Error("index file corrupt"), { code: 128, stderr: "fatal" });
    const failing = vi.fn<GitCommand>().mockRejectedValue(corrupt);
    await expect(listWorkingFolder("/work", failing)).rejects.toBe(corrupt);
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
