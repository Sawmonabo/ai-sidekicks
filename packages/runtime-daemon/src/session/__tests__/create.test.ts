// Creating a session over a real database, a real settings file and a real managed workspace: the
// lead runs on what the request names, never on the settings file's last pick, which the create
// then moves to it; a chat's managed workspace is made and bound inside the create; and a chat
// that is not born leaves neither a session nor a workspace behind.

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MACHINE_SETTINGS_DEFAULTS,
  type MachineSettings,
} from "@ai-sidekicks/contracts/machine-settings";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type {
  SessionCreateRequest,
  SessionCreateResponse,
} from "@ai-sidekicks/contracts/session/directory";
import type { SessionCreatedPayload } from "@ai-sidekicks/contracts/session/events";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { MachineSettingsFile } from "../../daemon/machine/settings/file.js";
import type { EventLogService } from "../../events/log-service.js";
import type { GitRunner } from "../../git/process.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { WorkspaceEventEmitter } from "../../workspace/event-emitter.js";
import {
  managedWorkspacesDirectoryOf,
  ManagedWorkspaceService,
} from "../../workspace/managed/service.js";
import { RepoMountService } from "../../workspace/repo/mount-service.js";
import { WorkspaceService } from "../../workspace/service.js";
import { SessionCreation } from "../create.js";
import { openSessionLog, type SessionLog } from "../directory/__fixtures__/session-log.js";
import { SessionService } from "../service.js";

const ACCOUNT_ID = "claude-work-account";
const SENT_LEAD = { driverName: "claude", modelId: "claude-sonnet-5", effort: "high" } as const;
const SETTINGS_ON_DISK: MachineSettings = {
  ...MACHINE_SETTINGS_DEFAULTS,
  advisorModel: "claude-opus-5",
  newSessionCarriesLastModel: true,
  lastLeadModel: { driverName: "claude", modelId: "claude-haiku-5", effort: "low" },
};

let log: SessionLog;
let home: string;
let settingsPath: string;
let emitter: WorkspaceEventEmitter;
let mounts: RepoMountService;
let creation: SessionCreation;

beforeEach(async () => {
  log = await openSessionLog();
  home = await mkdtemp(path.join(tmpdir(), "aisk-session-create-"));
  settingsPath = path.join(home, "machine-settings.json");
  await writeFile(settingsPath, JSON.stringify(SETTINGS_ON_DISK));
  const now = new Date().toISOString();
  await log.scratch.writer.write([
    {
      sql: `INSERT INTO provider_accounts
              (account_id, provider, credential_home_path, billing_mode, is_default, created_at,
               updated_at)
            VALUES (?, 'claude', ?, 'subscription', 1, ?, ?)`,
      bindings: [ACCOUNT_ID, path.join(home, "claude-home"), now, now],
    },
  ]);
  emitter = new WorkspaceEventEmitter({ sessionEvents: log.eventLog });
  mounts = new RepoMountService({
    database: log.scratch,
    events: emitter,
    nodeId: mintUuidV7() as NodeId,
  });
  creation = creationWith({});
});

// The create over the scratch database, with the event log or the workspace's git swapped out.
function creationWith(swap: {
  readonly events?: Pick<EventLogService, "append">;
  readonly git?: GitRunner;
}): SessionCreation {
  return new SessionCreation({
    reader: log.scratch.reader,
    events: swap.events ?? log.eventLog,
    workspaces: new WorkspaceService({
      database: log.scratch,
      events: emitter,
      sessions: new SessionService(log.scratch.reader),
    }),
    managedWorkspaces: new ManagedWorkspaceService({
      homeDirectory: home,
      repoMounts: mounts,
      ...(swap.git === undefined ? {} : { git: swap.git }),
    }),
    settingsFile: new MachineSettingsFile({ filePath: settingsPath, now: () => new Date() }),
  });
}

afterEach(async () => {
  await log.scratch.close();
  await rm(home, { recursive: true, force: true });
});

function createChat(using: SessionCreation = creation): Promise<SessionCreateResponse> {
  const request: SessionCreateRequest = {
    clientIdempotencyKey: mintUuidV7(),
    binding: { kind: "chat" },
    lead: SENT_LEAD,
  };
  return using.create(request);
}

function countRows(sql: string): number {
  return (log.scratch.reader.prepare(sql).get() as { count: number }).count;
}

function createdPayloadOf(sessionId: SessionId): SessionCreatedPayload {
  const row = log.scratch.reader
    .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'session.created'")
    .get(sessionId) as { payload: string };
  return JSON.parse(row.payload) as SessionCreatedPayload;
}

describe("SessionCreation", () => {
  it("runs the lead as sent on the current account, answers it, and keeps the pick", async () => {
    const { sessionId, lead } = await createChat();

    const born = { ...SENT_LEAD, providerAccountId: ACCOUNT_ID };
    expect(createdPayloadOf(sessionId).mainAgent.binding).toStrictEqual(born);
    expect(lead).toStrictEqual(born);
    const written = JSON.parse(await readFile(settingsPath, "utf8")) as MachineSettings;
    expect(written.lastLeadModel).toStrictEqual({
      driverName: "claude",
      modelId: "claude-sonnet-5",
      effort: "high",
    });
    // A Claude Code session holds its own copy of the advisor the settings file named.
    expect(
      log.scratch.reader
        .prepare("SELECT advisor_model FROM session_console_state WHERE session_id = ?")
        .get(sessionId),
    ).toStrictEqual({ advisor_model: "claude-opus-5" });
  });

  it("makes a chat's managed workspace and binds the chat to it in the same create", async () => {
    const { sessionId } = await createChat();

    const mount = log.scratch.reader
      .prepare(
        `SELECT mount.id, mount.canonical_root AS root
           FROM repo_mounts AS mount
           JOIN workspaces AS workspace ON workspace.repo_mount_id = mount.id
          WHERE mount.origin = 'managed' AND mount.managed_session_id = ?
            AND workspace.session_id = ?`,
      )
      .get(sessionId, sessionId) as { id: string; root: string } | undefined;
    expect(mount).toBeDefined();
    expect((await stat(path.join(mount?.root ?? "", ".git"))).isDirectory()).toBe(true);
    expect(new SessionService(log.scratch.reader).readSession({ sessionId }).session).toMatchObject(
      { shape: "chat", state: "active" },
    );
  });

  it("leaves no session when the chat's workspace cannot be made", async () => {
    const failingGit: GitRunner = () => Promise.reject(new Error("git init failed"));

    await expect(createChat(creationWith({ git: failingGit }))).rejects.toThrow("git init failed");

    expect(countRows("SELECT COUNT(*) AS count FROM sessions")).toBe(0);
    expect(countRows("SELECT COUNT(*) AS count FROM session_events")).toBe(0);
  });

  it("removes the chat's workspace when its session.created is not written", async () => {
    const refusingEvents = { append: () => Promise.reject(new Error("the disk is full")) };

    await expect(createChat(creationWith({ events: refusingEvents }))).rejects.toThrow(
      "the disk is full",
    );

    expect(countRows("SELECT COUNT(*) AS count FROM repo_mounts")).toBe(0);
    expect(await readdir(managedWorkspacesDirectoryOf(home))).toStrictEqual([]);
  });
});
