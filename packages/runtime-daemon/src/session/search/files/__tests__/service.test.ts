// The `@` file search over a real folder on disk: what it keeps, what it drops, and how a failed
// read reaches the caller.

import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_WORKING_FOLDER_UNAVAILABLE_CODE } from "@ai-sidekicks/contracts/session/methods";

import { runGitWithExecFile, type GitCommand } from "../../../../git/process.js";
import { SessionNotFoundError } from "../../../../ipc/session-errors.js";
import { openDatabase } from "../../../migration-runner.js";
import { insertSession, sessionIdOf } from "../../__fixtures__/index-rows.js";
import { listWorkingFolder } from "../listing.js";
import { FileSearchService } from "../service.js";

const TIMESTAMP = "2026-10-06T00:00:00.000Z";
const gitCommand: GitCommand = (argv) => runGitWithExecFile(argv, { timeoutMs: 10_000 });
const writeServiceLog = (line: string): void => {
  throw new Error(`unexpected service log line: ${line}`);
};

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
    const fileSearch = new FileSearchService({
      reader: database,
      git: gitCommand,
      writeServiceLog,
    });

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
    const fileSearch = new FileSearchService({
      reader: database,
      git: gitCommand,
      writeServiceLog,
    });

    await expect(fileSearch.search({ sessionId: sessionIdOf(9), query: "" })).rejects.toThrow(
      SessionNotFoundError,
    );
    database.prepare("UPDATE workspaces SET state = 'preparing', fs_root = NULL").run();
    await expect(fileSearch.search({ sessionId, query: "" })).rejects.toMatchObject({
      code: SESSION_WORKING_FOLDER_UNAVAILABLE_CODE,
      detail: { sessionId },
    });
  });
});

describe("listWorkingFolder", () => {
  // The person's own excludes file is no rule of the folder's.
  const repositoryGit: GitCommand = (argv) =>
    runGitWithExecFile(argv, {
      timeoutMs: 10_000,
      environmentOverrides: { GIT_CONFIG_GLOBAL: "/dev/null" },
    });

  it("lists a folder outside git as git lists it, every .gitignore honored and .git skipped", async () => {
    const folder = await realpath(await mkdtemp(join(tmpdir(), "file-listing-")));
    const files: Record<string, string> = {
      ".gitignore": "*.log\nbuild/\n",
      "keep.ts": "",
      "a.log": "",
      "build/out.js": "",
      // A nested file's rules reach only below it, may re-include, and anchor to its folder.
      "pkg/.gitignore": "secret.txt\n!important.log\n/local.ts\n",
      "pkg/secret.txt": "",
      "pkg/important.log": "",
      "pkg/local.ts": "",
      "pkg/sub/local.ts": "",
      "pkg/sub/deeper.log": "",
      "other/secret.txt": "",
      // Git reads no rules from a folder named .gitignore or through a link, and lists both.
      "odd/.gitignore/inner.ts": "",
      "linked-rules.txt": "hidden.ts\n",
      "linked/hidden.ts": "",
    };
    try {
      for (const [path, content] of Object.entries(files)) {
        await mkdir(join(folder, path, ".."), { recursive: true });
        await writeFile(join(folder, path), content);
      }
      await symlink(join(folder, "linked-rules.txt"), join(folder, "linked", ".gitignore"));
      // A folder named .git that is no repository leaves the folder outside git.
      await mkdir(join(folder, ".git"));
      await writeFile(join(folder, ".git", "stray.ts"), "");

      const walkLog: string[] = [];
      const walked = (
        await listWorkingFolder(folder, repositoryGit, (line) => {
          walkLog.push(line);
        })
      ).sort();
      await rm(join(folder, ".git"), { recursive: true });
      await repositoryGit(["-C", folder, "init", "--quiet"]);
      const gitLog: string[] = [];
      const listedByGit = (
        await listWorkingFolder(folder, repositoryGit, (line) => {
          gitLog.push(line);
        })
      ).sort();

      expect(walked).toEqual([
        ".gitignore",
        "keep.ts",
        "linked-rules.txt",
        "linked/.gitignore",
        "linked/hidden.ts",
        "odd/.gitignore/inner.ts",
        "other/secret.txt",
        "pkg/.gitignore",
        "pkg/important.log",
        "pkg/sub/local.ts",
      ]);
      expect(walked).toEqual(listedByGit);
      // Each names the linked rules file it read no rules through, as git warns of it.
      for (const log of [walkLog, gitLog]) {
        expect(log).toHaveLength(1);
        expect(log[0]).toContain("linked/.gitignore");
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it.each([
    ["outside git", false],
    ["inside a git working tree", true],
  ])(
    "lists past a .gitignore it cannot read, its rules unread as in git, and logs it, %s",
    async (_label, isGit) => {
      const folder = await realpath(await mkdtemp(join(tmpdir(), "file-listing-")));
      const rulesPath = join(folder, "locked", ".gitignore");
      try {
        await mkdir(join(folder, "locked"));
        await writeFile(join(folder, "locked", "a.log"), "");
        await writeFile(rulesPath, "*.log\n");
        await chmod(rulesPath, 0o000);
        if (isGit) {
          await repositoryGit(["-C", folder, "init", "--quiet"]);
        }
        const logged: string[] = [];

        const listed = await listWorkingFolder(folder, repositoryGit, (line) => {
          logged.push(line);
        });

        expect(listed.sort()).toEqual(["locked/.gitignore", "locked/a.log"]);
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain("locked/.gitignore");
      } finally {
        await chmod(rulesPath, 0o644);
        await rm(folder, { recursive: true, force: true });
      }
    },
  );

  const busy = Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" });

  it("tries a retryable read once more and answers its listing", async () => {
    const git = vi
      .fn<GitCommand>()
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce({ stdout: Buffer.from("a.ts\0b.ts\0"), stderr: "" });

    await expect(listWorkingFolder("/work", git, writeServiceLog)).resolves.toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(git).toHaveBeenCalledTimes(2);
  });

  it("surfaces a second retryable failure as the failed read, and retries no other", async () => {
    const twiceBusy = vi.fn<GitCommand>().mockRejectedValue(busy);
    await expect(listWorkingFolder("/work", twiceBusy, writeServiceLog)).rejects.toBe(busy);
    expect(twiceBusy).toHaveBeenCalledTimes(2);

    const corrupt = Object.assign(new Error("index file corrupt"), { code: 128, stderr: "fatal" });
    const failing = vi.fn<GitCommand>().mockRejectedValue(corrupt);
    await expect(listWorkingFolder("/work", failing, writeServiceLog)).rejects.toBe(corrupt);
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
