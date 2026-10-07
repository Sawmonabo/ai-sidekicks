// Converting a chat over a real database, real folders and real git: the chat's files land in the
// repository without replacing any file it holds, the session keeps its id and transcript and reads
// as a project of the new mount, a folder that cannot be attached is refused with nothing copied,
// no link is followed out of either folder, every file not copied is read back page by page with
// its reason, and a convert retried with its key answers the conversion it made.

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
import {
  SessionConvertSkippedFileListResponseSchema,
  type SessionConvertedPayload,
  type SessionConvertSkippedFile,
  type SessionConvertSkippedFileCursor,
} from "@ai-sidekicks/contracts/session/convert";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { FILE_PATH_MAX_LEN } from "@ai-sidekicks/contracts/free-form-string";

import { SessionNotFoundError } from "../../ipc/session-errors.js";
import { KeyedLock } from "../../keyed-lock.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { WorkspaceEventEmitter } from "../../workspace/event-emitter.js";
import { ManagedWorkspaceService } from "../../workspace/managed/service.js";
import { RepoMountService } from "../../workspace/repo/mount-service.js";
import { WorkspaceService } from "../../workspace/service.js";
import { SessionConversion } from "../convert.js";
import { openSessionLog, type SessionLog } from "../directory/__fixtures__/event-log.js";

// More pages than any list here takes, so a cursor that never moves fails instead of hanging.
const MAX_PAGES_READ = 50;

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
  workspaces = new WorkspaceService({ database: log.scratch, events: emitter });
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

// Every file the session's conversion did not copy, read page by page with `limit`, each page
// checked against the wire's schema; a cursor that never ends the list fails the read.
function skippedFilesOf(sessionId: SessionId, limit?: number): SessionConvertSkippedFile[] {
  const files: SessionConvertSkippedFile[] = [];
  let afterCursor: SessionConvertSkippedFileCursor | undefined;
  for (let pageCount = 0; pageCount < MAX_PAGES_READ; pageCount += 1) {
    const page = SessionConvertSkippedFileListResponseSchema.parse(
      conversion.listSkippedFiles({
        sessionId,
        ...(afterCursor === undefined ? {} : { afterCursor }),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
    files.push(...page.files);
    if (!page.hasMore) {
      return files;
    }
    afterCursor = page.nextCursor;
  }
  throw new Error(
    `The skipped files of ${sessionId} did not end within ${String(MAX_PAGES_READ)} pages`,
  );
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

    const outcome = { copiedCount: 2, skippedCount: 1 };
    expect(response).toStrictEqual(outcome);
    expect(skippedFilesOf(sessionId)).toStrictEqual([
      { path: "README.md", reason: "repository_has_file" },
    ]);
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
    expect(payload).toStrictEqual({ sessionId, repoMountId: payload.repoMountId, ...outcome });
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

  it("follows no link out of the workspace or the repository, and names what it left", async () => {
    const sessionId = mintUuidV7() as SessionId;
    const workspace = await startChat(sessionId, {
      "docs/guide.md": "the guide",
      "plan.md": "plan",
    });
    const outside = path.join(scratch, "outside");
    await writeFiles(outside, { "secret.txt": "secret", "folder/inner.txt": "inner" });
    await symlink(path.join(outside, "secret.txt"), path.join(workspace, "secret-link"));
    await symlink(path.join(outside, "folder"), path.join(workspace, "folder-link"));
    execFileSync("mkfifo", [path.join(workspace, "pipe")]);
    const repository = await makeRepository("project", {});
    // The repository's own `docs` is a link out of it, so nothing is written through it.
    await symlink(outside, path.join(repository, "docs"));
    // The folder is already this machine's project, so its mount is reused.
    const existing = await mounts.attach({ localPath: repository });

    const response = await convert(sessionId, repository);

    expect(response).toStrictEqual({ copiedCount: 1, skippedCount: 4 });
    expect(skippedFilesOf(sessionId)).toStrictEqual([
      { path: "docs/guide.md", reason: "repository_path_not_a_folder" },
      { path: "folder-link", reason: "link" },
      { path: "pipe", reason: "special_file" },
      { path: "secret-link", reason: "link" },
    ]);
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
      code: "session.convert_incomplete",
      detail: { sessionId, copiedCount: 1, skippedCount: 0, isBound: false },
    });
    expect(sessionShape(sessionId)).toBe("chat");
    expect(eventsOf(sessionId)).toStrictEqual(transcriptBefore);
  });

  it("reads back every file it left exactly once, in path order, over many pages", async () => {
    const sessionId = mintUuidV7() as SessionId;
    const clashing = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [`notes/${String(index)}.md`, "the chat's"]),
    );
    await startChat(sessionId, clashing);
    const repository = await makeRepository("project", clashing);

    const response = await convert(sessionId, repository);

    expect(response).toStrictEqual({ copiedCount: 0, skippedCount: 7 });
    expect(skippedFilesOf(sessionId, 2)).toStrictEqual(
      Object.keys(clashing)
        .sort()
        .map((path) => ({ path, reason: "repository_has_file" })),
    );
  });

  it("cuts a page of long paths at the page budget and still reads every one", async () => {
    const sessionId = mintUuidV7() as SessionId;
    await log.createSession(sessionId, "project");
    // Paths at the wire's bound in three-byte characters, so far fewer than a page's count fit.
    const paths = Array.from(
      { length: 120 },
      (_, index) => `${String(index).padStart(3, "0")}/${"語".repeat(FILE_PATH_MAX_LEN - 4)}`,
    );
    await log.scratch.writer.write([
      {
        sql: `INSERT INTO session_convert_skipped_files (session_id, path, reason)
              SELECT ?, value, 'link' FROM json_each(?)`,
        bindings: [sessionId, JSON.stringify(paths)],
      },
    ]);

    const firstPage = conversion.listSkippedFiles({ sessionId });

    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.files.length).toBeLessThan(paths.length);
    expect(skippedFilesOf(sessionId).map((file) => file.path)).toStrictEqual(paths);
  });

  it("answers a retried convert with the conversion its key made, copying nothing", async () => {
    const sessionId = mintUuidV7() as SessionId;
    await startChat(sessionId, { "README.md": "the chat's", "plan.md": "the plan" });
    const repository = await makeRepository("project", { "README.md": "the repository's" });
    const request = { sessionId, path: repository, clientIdempotencyKey: mintUuidV7() };

    const first = await conversion.convert(request);
    await rm(path.join(repository, "plan.md"));
    const eventsBefore = eventsOf(sessionId);
    const retried = await conversion.convert(request);

    expect(retried).toStrictEqual(first);
    expect(first).toStrictEqual({ copiedCount: 1, skippedCount: 1 });
    expect(eventsOf(sessionId)).toStrictEqual(eventsBefore);
    expect((await readdir(repository)).sort()).toStrictEqual([".git", "README.md"]);
    // Another key is another request, and a project does not convert.
    await expect(convert(sessionId, repository)).rejects.toMatchObject({
      code: "session.convert_refused",
    });
  });

  it("converts one of two chats sent at once with one key, refusing the other with nothing attached", async () => {
    const firstChatId = mintUuidV7() as SessionId;
    await startChat(firstChatId, { "plan.md": "the plan" });
    const secondChatId = mintUuidV7() as SessionId;
    await startChat(secondChatId, { "notes.md": "notes" });
    const firstRepository = await makeRepository("first", {});
    const secondRepository = await makeRepository("second", {});
    const secondChatEvents = eventsOf(secondChatId);
    const clientIdempotencyKey = mintUuidV7();

    const [first, second] = await Promise.allSettled([
      conversion.convert({ sessionId: firstChatId, path: firstRepository, clientIdempotencyKey }),
      conversion.convert({ sessionId: secondChatId, path: secondRepository, clientIdempotencyKey }),
    ]);

    expect(first).toStrictEqual({
      status: "fulfilled",
      value: { copiedCount: 1, skippedCount: 0 },
    });
    expect(second).toMatchObject({
      status: "rejected",
      reason: {
        code: "session.convert_refused",
        detail: { sessionId: secondChatId, reason: "idempotency_key_reused" },
      },
    });
    expect(attachedMountCount()).toBe(1);
    expect(await readdir(secondRepository)).toStrictEqual([".git"]);
    expect(sessionShape(secondChatId)).toBe("chat");
    expect(eventsOf(secondChatId)).toStrictEqual(secondChatEvents);
  });

  it("refuses the skipped files of a session it holds no row for", () => {
    expect(() => conversion.listSkippedFiles({ sessionId: mintUuidV7() as SessionId })).toThrow(
      SessionNotFoundError,
    );
  });

  it("refuses a chat with no managed workspace, and one being purged, with nothing attached", async () => {
    const bareChatId = mintUuidV7() as SessionId;
    await log.createSession(bareChatId, "chat");
    const purgingId = mintUuidV7() as SessionId;
    await startChat(purgingId, { "plan.md": "plan" });
    await log.scratch.writer.write([
      {
        sql: "UPDATE sessions SET state = 'purge_requested' WHERE id = ?",
        bindings: [purgingId],
        expectedRowCount: 1,
      },
    ]);
    const repository = await makeRepository("project", {});

    await expect(convert(bareChatId, repository)).rejects.toMatchObject({
      code: "session.convert_refused",
      detail: { reason: "no_managed_workspace" },
    });
    await expect(convert(purgingId, repository)).rejects.toMatchObject({
      code: "session.change_refused",
    });
    expect(attachedMountCount()).toBe(0);
    expect(await readdir(repository)).toStrictEqual([".git"]);
  });
});
