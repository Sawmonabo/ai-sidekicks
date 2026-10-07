// Converting a chat over a real database, real folders and real git: the chat's files land in the
// repository without replacing any file it holds, the session keeps its id and transcript and reads
// as a project of the new mount, a folder that cannot be attached is refused with nothing copied,
// and no link is followed out of either folder.

import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { SessionConvertedPayload } from "@ai-sidekicks/contracts/session/convert";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { KeyedLock } from "../../keyed-lock.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { WorkspaceEventEmitter } from "../../workspace/event-emitter.js";
import { ManagedWorkspaceService } from "../../workspace/managed/service.js";
import { RepoMountService } from "../../workspace/repo/mount-service.js";
import { WorkspaceService } from "../../workspace/service.js";
import { SessionConversion } from "../convert.js";
import { openSessionLog, type SessionLog } from "../directory/__fixtures__/session-log.js";
import { SessionService } from "../service.js";

let log: SessionLog;
let scratch: string;
let mounts: RepoMountService;
let workspaces: WorkspaceService;
let managedWorkspaces: ManagedWorkspaceService;
let conversion: SessionConversion;

beforeEach(async () => {
  log = await openSessionLog();
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), "aisk-session-convert-")));
  const emitter = new WorkspaceEventEmitter({ sessionEvents: log.eventLog });
  mounts = new RepoMountService({
    database: log.scratch,
    events: emitter,
    nodeId: mintUuidV7() as NodeId,
  });
  workspaces = new WorkspaceService({
    database: log.scratch,
    events: emitter,
    sessions: new SessionService(log.scratch.reader),
  });
  managedWorkspaces = new ManagedWorkspaceService({
    homeDirectory: path.join(scratch, "home"),
    repoMounts: mounts,
  });
  conversion = conversionBindingThrough(workspaces);
});

function conversionBindingThrough(binder: Pick<WorkspaceService, "bind">): SessionConversion {
  return new SessionConversion({
    reader: log.scratch.reader,
    events: log.eventLog,
    lock: new KeyedLock<SessionId>(),
    repoMounts: mounts,
    workspaces: binder,
  });
}

afterEach(async () => {
  await log.scratch.close();
  await rm(scratch, { recursive: true, force: true });
});

// A chat bound to its managed workspace, as a create leaves it, with one exchange in its
// transcript and `files` written into the workspace; answers the workspace's folder.
async function startChat(
  sessionId: SessionId,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  await log.createSession(sessionId, "chat");
  const workspace = await managedWorkspaces.create({ sessionId });
  await workspaces.bind({
    sessionId,
    repoMountId: workspace.repoMountId,
    executionMode: "bound-root",
  });
  await log.append(sessionId, "user.message", "interactive_request", {
    sessionId,
    actor: "person",
    message: "Sketch the plan",
  });
  await writeFiles(workspace.path, files);
  return workspace.path;
}

async function makeRepository(
  name: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const folder = path.join(scratch, name);
  await mkdir(folder, { recursive: true });
  execFileSync("git", ["init", "--quiet", folder]);
  await writeFiles(folder, files);
  return folder;
}

async function writeFiles(folder: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relativePath, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, relativePath)), { recursive: true });
    await writeFile(path.join(folder, relativePath), text);
  }
}

function convert(sessionId: SessionId, typedPath: string, using: SessionConversion = conversion) {
  return using.convert({ sessionId, path: typedPath, clientIdempotencyKey: mintUuidV7() });
}

function sessionShape(sessionId: SessionId): string {
  return (
    log.scratch.reader.prepare("SELECT shape FROM sessions WHERE id = ?").get(sessionId) as {
      shape: string;
    }
  ).shape;
}

// The project a session belongs to: the attached mount its newest workspace binds.
function projectOf(sessionId: SessionId): string | undefined {
  const row = log.scratch.reader
    .prepare(
      `SELECT w.repo_mount_id AS repoMountId
         FROM workspaces w JOIN repo_mounts m ON m.id = w.repo_mount_id
        WHERE w.session_id = ? AND m.origin = 'attached'
        ORDER BY w.created_at DESC, w.id DESC LIMIT 1`,
    )
    .get(sessionId) as { repoMountId: string } | undefined;
  return row?.repoMountId;
}

function eventsOf(sessionId: SessionId): { id: string; type: string; payload: string }[] {
  return log.scratch.reader
    .prepare("SELECT id, type, payload FROM session_events WHERE session_id = ? ORDER BY sequence")
    .all(sessionId) as { id: string; type: string; payload: string }[];
}

function attachedMountCount(): number {
  return (
    log.scratch.reader
      .prepare("SELECT count(*) AS count FROM repo_mounts WHERE origin = 'attached'")
      .get() as { count: number }
  ).count;
}

describe("SessionConversion", () => {
  it("copies the chat's files in, leaves a file the repository holds untouched, and keeps the session", async () => {
    const sessionId = mintUuidV7() as SessionId;
    const workspace = await startChat(sessionId, {
      "README.md": "the chat's readme",
      "notes/plan.md": "the plan",
      "src/main.ts": "export {};",
    });
    const repository = await makeRepository("project", {
      "README.md": "the repository's readme",
      "notes/existing.md": "kept",
    });
    const transcriptBefore = eventsOf(sessionId);

    const response = await convert(sessionId, repository);

    expect(response).toStrictEqual({ copiedCount: 2, skippedPaths: ["README.md"] });
    expect(await readFile(path.join(repository, "README.md"), "utf8")).toBe(
      "the repository's readme",
    );
    expect(await readFile(path.join(repository, "notes/plan.md"), "utf8")).toBe("the plan");
    expect(await readFile(path.join(repository, "src/main.ts"), "utf8")).toBe("export {};");
    // The workspace is kept whole, the file left behind and its history among it.
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("the chat's readme");
    expect((await lstat(path.join(workspace, ".git"))).isDirectory()).toBe(true);

    const transcriptAfter = eventsOf(sessionId);
    expect(transcriptAfter.slice(0, transcriptBefore.length)).toStrictEqual(transcriptBefore);
    const converted = transcriptAfter.at(-1);
    expect(converted?.type).toBe("session.converted");
    const payload = JSON.parse(converted?.payload ?? "{}") as SessionConvertedPayload;
    expect(payload).toStrictEqual({
      sessionId,
      repoMountId: payload.repoMountId,
      copiedCount: 2,
      skippedPaths: ["README.md"],
    });
    expect(sessionShape(sessionId)).toBe("project");
    expect(projectOf(sessionId)).toBe(payload.repoMountId);
  });

  it("refuses a path that is not a folder, or not one to convert into, with nothing copied", async () => {
    const sessionId = mintUuidV7() as SessionId;
    const workspace = await startChat(sessionId, { "plan.md": "the plan" });
    const repository = await makeRepository("project", { "README.md": "readme" });
    const transcriptBefore = eventsOf(sessionId);

    await expect(convert(sessionId, path.join(repository, "README.md"))).rejects.toMatchObject({
      code: "repo.root_resolution_failed",
    });
    await expect(convert(sessionId, path.join(scratch, "missing"))).rejects.toMatchObject({
      code: "repo.root_resolution_failed",
      detail: { reason: "path_not_found" },
    });
    // A chat's own workspace is never a project.
    await expect(convert(sessionId, workspace)).rejects.toMatchObject({
      code: "repo.already_attached",
    });

    expect((await readdir(repository)).sort()).toStrictEqual([".git", "README.md"]);
    expect(attachedMountCount()).toBe(0);
    expect(sessionShape(sessionId)).toBe("chat");
    expect(eventsOf(sessionId)).toStrictEqual(transcriptBefore);
  });

  it("follows no link out of the workspace or the repository", async () => {
    const sessionId = mintUuidV7() as SessionId;
    const workspace = await startChat(sessionId, {
      "docs/guide.md": "the guide",
      "plan.md": "plan",
    });
    const outside = path.join(scratch, "outside");
    await writeFiles(outside, { "secret.txt": "secret", "folder/inner.txt": "inner" });
    await symlink(path.join(outside, "secret.txt"), path.join(workspace, "secret-link"));
    await symlink(path.join(outside, "folder"), path.join(workspace, "folder-link"));
    const repository = await makeRepository("project", {});
    // The repository's own `docs` is a link out of it, so nothing is written through it.
    await symlink(outside, path.join(repository, "docs"));
    // The folder is already this machine's project, so its mount is reused.
    const existing = await mounts.attach({ localPath: repository });

    const response = await convert(sessionId, repository);

    expect(response).toStrictEqual({ copiedCount: 1, skippedPaths: ["docs/guide.md"] });
    expect((await readdir(repository)).sort()).toStrictEqual([".git", "docs", "plan.md"]);
    expect((await readdir(outside)).sort()).toStrictEqual(["folder", "secret.txt"]);
    expect(projectOf(sessionId)).toBe(existing.repoMountId);
    expect(attachedMountCount()).toBe(1);
  });

  it("refuses a closed chat and a session that is already a project", async () => {
    const closedId = mintUuidV7() as SessionId;
    await startChat(closedId, { "plan.md": "plan" });
    await log.append(closedId, "session.closed", "session_lifecycle", {
      sessionId: closedId,
      previousState: "active",
      newState: "closed",
    });
    const convertedId = mintUuidV7() as SessionId;
    await startChat(convertedId, { "plan.md": "plan" });
    const first = await makeRepository("first", {});
    await convert(convertedId, first);
    const second = await makeRepository("second", {});

    await expect(convert(closedId, second)).rejects.toMatchObject({
      code: "session.already_closed",
    });
    await expect(convert(convertedId, second)).rejects.toMatchObject({
      code: "session.convert_refused",
    });
    expect(await readdir(second)).toStrictEqual([".git"]);
  });

  it("says what it did when it stops part way, and leaves the session a chat", async () => {
    const sessionId = mintUuidV7() as SessionId;
    await startChat(sessionId, { "plan.md": "the plan" });
    const repository = await makeRepository("project", {});
    const failingBind = conversionBindingThrough({
      bind: () => Promise.reject(new Error("the bind failed")),
    });
    const transcriptBefore = eventsOf(sessionId);

    await expect(convert(sessionId, repository, failingBind)).rejects.toMatchObject({
      name: "SessionConversionIncompleteError",
      copiedCount: 1,
      skippedPaths: [],
      isBound: false,
    });
    expect(sessionShape(sessionId)).toBe("chat");
    expect(eventsOf(sessionId)).toStrictEqual(transcriptBefore);
  });
});
