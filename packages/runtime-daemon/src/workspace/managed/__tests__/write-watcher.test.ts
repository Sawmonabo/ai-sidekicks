// The one watch over every chat's workspace reports each file and folder a chat writes, once, with
// its session and its path inside the workspace, and reports neither the workspace's `.git` folder,
// the workspace folder itself nor a removal. Real folders and the operating system's own change feed.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { managedWorkspacesDirectoryOf } from "../service.js";
import { ManagedWorkspaceWriteWatcher, type ManagedWorkspaceWrite } from "../write-watcher.js";

const SESSION_ID = "0190f9d0-0000-7000-8000-000000000001" as SessionId;
const OTHER_SESSION_ID = "0190f9d0-0000-7000-8000-000000000002" as SessionId;
const NEW_SESSION_ID = "0190f9d0-0000-7000-8000-000000000003" as SessionId;
// The change feed takes a moment to start after the watch is opened; a probe write is repeated
// at this pace until one is reported, so the test never races the feed's start.
const READY_PROBE_INTERVAL_MS = 50;
const REPORT_TIMEOUT_MS = 5_000;
// The probes' own files, which a probe may write more than once, are left out of what an arm reads.
const PROBE_FILE_NAMES: ReadonlySet<string> = new Set([
  "ready-probe",
  "sentinel",
  "second-sentinel",
  "third-sentinel",
]);

let homeDirectory: string;
let watcher: ManagedWorkspaceWriteWatcher;
let reports: ManagedWorkspaceWrite[];
let serviceLogLines: string[];

beforeEach(async () => {
  homeDirectory = mkdtempSync(join(tmpdir(), "ai-sidekicks-managed-watch-"));
  reports = [];
  serviceLogLines = [];
  watcher = new ManagedWorkspaceWriteWatcher({
    homeDirectory,
    writeServiceLog: (line) => serviceLogLines.push(line),
  });
  await watcher.start();
  watcher.onWrite((write) => reports.push(write));
  for (const sessionId of [SESSION_ID, OTHER_SESSION_ID]) {
    mkdirSync(join(managedWorkspacesDirectoryOf(homeDirectory), sessionId, ".git"), {
      recursive: true,
    });
  }
  await writeUntilReported(SESSION_ID, "ready-probe");
  reports.length = 0;
});

afterEach(() => {
  watcher.close();
  rmSync(homeDirectory, { recursive: true, force: true });
});

function workspaceFile(sessionId: SessionId, relativePath: string): string {
  return join(managedWorkspacesDirectoryOf(homeDirectory), sessionId, relativePath);
}

function readChatWrites(): readonly ManagedWorkspaceWrite[] {
  return reports.filter((write) => !PROBE_FILE_NAMES.has(write.relativePath));
}

function isReported(sessionId: SessionId, relativePath: string): boolean {
  return reports.some(
    (write) => write.sessionId === sessionId && write.relativePath === relativePath,
  );
}

/** Writes the file, again at each probe interval, until a report names it. */
async function writeUntilReported(sessionId: SessionId, relativePath: string): Promise<void> {
  const deadline = Date.now() + REPORT_TIMEOUT_MS;
  while (!isReported(sessionId, relativePath)) {
    if (Date.now() > deadline) {
      throw new Error(`no report of ${relativePath} within ${String(REPORT_TIMEOUT_MS)} ms`);
    }
    writeFileSync(workspaceFile(sessionId, relativePath), "probe\n");
    await new Promise((resolve) => setTimeout(resolve, READY_PROBE_INTERVAL_MS));
  }
}

describe("ManagedWorkspaceWriteWatcher", () => {
  it("reports each write a chat makes once, with its session and path", async () => {
    const planPath = workspaceFile(SESSION_ID, join("notes", "plan.md"));
    mkdirSync(workspaceFile(SESSION_ID, "notes"));
    writeFileSync(planPath, "# Plan\n");
    writeFileSync(workspaceFile(OTHER_SESSION_ID, "summary.txt"), "elsewhere\n");
    // Reports arrive in order, so the sentinel's report follows every report of the writes above.
    await writeUntilReported(SESSION_ID, "sentinel");
    // A mode change writes nothing, though the feed names it; a second write to the same file is
    // a write of its own. Each is delivered before the next lands.
    chmodSync(planPath, 0o600);
    await writeUntilReported(SESSION_ID, "second-sentinel");
    writeFileSync(planPath, "# Plan, revised\n");
    await writeUntilReported(SESSION_ID, "third-sentinel");

    const plan = { sessionId: SESSION_ID, relativePath: "notes/plan.md", kind: "file" };
    expect(readChatWrites()).toEqual([
      { sessionId: SESSION_ID, relativePath: "notes", kind: "directory" },
      plan,
      { sessionId: OTHER_SESSION_ID, relativePath: "summary.txt", kind: "file" },
      plan,
    ]);
    expect(serviceLogLines).toEqual([]);
  });

  it("reports neither the workspace's .git folder, a new workspace folder nor a removal", async () => {
    mkdirSync(join(managedWorkspacesDirectoryOf(homeDirectory), NEW_SESSION_ID));
    writeFileSync(workspaceFile(SESSION_ID, join(".git", "index")), "git's own\n");
    writeFileSync(workspaceFile(SESSION_ID, "scratch.txt"), "short-lived\n");
    rmSync(workspaceFile(SESSION_ID, "scratch.txt"));
    await writeUntilReported(SESSION_ID, "sentinel");

    expect(readChatWrites()).toEqual([]);
  });
});
