// Creating a session over a real database, a real settings file and a real managed workspace: the
// lead runs on what the request names, never on the settings file's last pick, which the create
// then moves to it; a chat's managed workspace is made and bound inside the create; a chat that is
// not born leaves neither a session nor a workspace behind; a create retried with its key, even
// while the first is still on its way, answers the first one's session and makes nothing; a
// project create names an attached project's mount or writes nothing; and a session left
// provisioning is finished by its create's retry or by the daemon's start, which also removes the
// workspace of a chat whose create stopped before it was born.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MACHINE_SETTINGS_DEFAULTS,
  type MachineSettings,
} from "@ai-sidekicks/contracts/machine-settings";
import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type {
  SessionCreateRequest,
  SessionCreateResponse,
} from "@ai-sidekicks/contracts/session/directory";
import type { SessionCreatedPayload } from "@ai-sidekicks/contracts/session/events";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { captureRejection } from "../../__fixtures__/capture-failure.js";
import { MachineSettingsFile } from "../../daemon/machine/settings/file.js";
import type { EventLogService } from "../../events/log-service.js";
import { DaemonDomainError } from "../../ipc/domain-error.js";
import type { GitRunner } from "../../git/process.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { WorkspaceEventEmitter } from "../../workspace/event-emitter.js";
import {
  managedWorkspacesDirectoryOf,
  ManagedWorkspaceService,
} from "../../workspace/managed/service.js";
import { buildTestProjectService } from "../../workspace/project/service.test-support.js";
import { RepoMountService } from "../../workspace/repo/mount-service.js";
import { WorkspaceService } from "../../workspace/service.js";
import { SessionCreation } from "../create.js";
import { openSessionLog, type SessionLog } from "../directory/__fixtures__/event-log.js";
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
let serviceLogLines: string[];
let workspacesMade: number;

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
  serviceLogLines = [];
  workspacesMade = 0;
  creation = creationWith({});
});

// The create over the scratch database, with the event log, the bind, the workspace's git, the
// managed workspaces' removal or the settings file's write swapped out.
function creationWith(swap: {
  readonly events?: Pick<EventLogService, "append">;
  readonly bind?: WorkspaceService["bind"];
  readonly git?: GitRunner;
  readonly removeWorkspace?: ManagedWorkspaceService["delete"];
  readonly updateSettings?: MachineSettingsFile["update"];
}): SessionCreation {
  const managedWorkspaces = new ManagedWorkspaceService({
    homeDirectory: home,
    repoMounts: mounts,
    ...(swap.git === undefined ? {} : { git: swap.git }),
  });
  const settingsFile = new MachineSettingsFile({ filePath: settingsPath, now: () => new Date() });
  const workspaces = new WorkspaceService({ database: log.scratch, events: emitter });
  return new SessionCreation({
    reader: log.scratch.reader,
    events: swap.events ?? log.eventLog,
    workspaces: { bind: swap.bind ?? ((input) => workspaces.bind(input)) },
    managedWorkspaces: {
      create: (input) => {
        workspacesMade += 1;
        return managedWorkspaces.create(input);
      },
      delete: swap.removeWorkspace ?? ((input) => managedWorkspaces.delete(input)),
    },
    settingsFile: {
      read: () => settingsFile.read(),
      update: swap.updateSettings ?? ((change) => settingsFile.update(change)),
    },
    writeServiceLog: (line) => serviceLogLines.push(line),
  });
}

afterEach(async () => {
  await log.scratch.close();
  await rm(home, { recursive: true, force: true });
});

function chatRequest(): SessionCreateRequest {
  return { clientIdempotencyKey: mintUuidV7(), binding: { kind: "chat" }, lead: SENT_LEAD };
}

function createChat(using: SessionCreation = creation): Promise<SessionCreateResponse> {
  return using.create(chatRequest());
}

function countRows(sql: string): number {
  return (log.scratch.reader.prepare(sql).get() as { count: number }).count;
}

function stateOf(sessionId: SessionId): string | undefined {
  return (
    log.scratch.reader.prepare("SELECT state FROM sessions WHERE id = ?").get(sessionId) as
      | { state: string }
      | undefined
  )?.state;
}

function eventTypesOf(sessionId: SessionId): string[] {
  return (
    log.scratch.reader
      .prepare("SELECT type FROM session_events WHERE session_id = ? ORDER BY sequence")
      .all(sessionId) as { type: string }[]
  ).map((row) => row.type);
}

// The one session a refused create left behind.
function onlySessionId(): SessionId {
  return (log.scratch.reader.prepare("SELECT id FROM sessions").get() as { id: SessionId }).id;
}

const failingBind = (): Promise<never> => Promise.reject(new Error("the bind failed"));

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

  it("answers a create sent again, even while the first is on its way, with its session", async () => {
    const request = chatRequest();

    const [first, again] = await Promise.all([creation.create(request), creation.create(request)]);
    const later = await creation.create(request);

    expect(again).toStrictEqual(first);
    expect(later).toStrictEqual(first);
    expect(workspacesMade).toBe(1);
    expect(countRows("SELECT COUNT(*) AS count FROM sessions")).toBe(1);
    expect(countRows("SELECT COUNT(*) AS count FROM repo_mounts")).toBe(1);
    expect(await readdir(managedWorkspacesDirectoryOf(home))).toHaveLength(1);
  });

  it("finishes a session whose bind failed when its create is retried", async () => {
    const request = chatRequest();
    await expect(creationWith({ bind: failingBind }).create(request)).rejects.toThrow(
      "the bind failed",
    );
    const sessionId = onlySessionId();
    expect(stateOf(sessionId)).toBe("provisioning");

    const retried = await creation.create(request);

    expect(retried).toMatchObject({ sessionId, shape: "chat", state: "active" });
    expect(retried.lead).toStrictEqual({ ...SENT_LEAD, providerAccountId: ACCOUNT_ID });
    expect(stateOf(sessionId)).toBe("active");
    expect(eventTypesOf(sessionId)).toStrictEqual([
      "session.created",
      "workspace.preparing",
      "session.activated",
    ]);
    expect(workspacesMade).toBe(1);
    const written = JSON.parse(await readFile(settingsPath, "utf8")) as MachineSettings;
    expect(written.lastLeadModel).toStrictEqual({
      driverName: "claude",
      modelId: "claude-sonnet-5",
      effort: "high",
    });
  });

  it("finishes at start each session left provisioning, and throws for one it cannot finish", async () => {
    const leftBinding = creationWith({ bind: failingBind });
    await expect(leftBinding.create(chatRequest())).rejects.toThrow("the bind failed");
    const chatId = onlySessionId();
    const { projectId, repoMountId } = await attachProject();
    await expect(leftBinding.create(projectRequest(projectId))).rejects.toThrow("the bind failed");
    const projectSessionId = (
      log.scratch.reader.prepare("SELECT id FROM sessions WHERE shape = 'project'").get() as {
        id: SessionId;
      }
    ).id;
    // The project's folder is detached before the start, so its session has nowhere left to bind.
    await mounts.detach({ repoMountId });

    const failure = await captureRejection(creation.finishProvisioningSessions());

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect((failure as AggregateError).message).toContain(projectSessionId);
    expect(stateOf(chatId)).toBe("active");
    expect(stateOf(projectSessionId)).toBe("provisioning");
    expect(serviceLogLines).toStrictEqual([]);
  });

  it("keeps a session of a project still cloning provisioning until the clone attaches", async () => {
    const repository = path.join(home, "beacon");
    const { projects } = buildTestProjectService({
      database: log.scratch,
      mounts,
      worktreesDirectory: path.join(home, "worktrees"),
    });
    const projectId = await projects.createCloningProject({
      url: "https://example.invalid/acme/beacon.git",
      folderPath: repository,
      name: "beacon",
    });

    const { sessionId, state } = await creation.create(projectRequest(projectId));
    await creation.finishProvisioningSessions();

    expect(state).toBe("provisioning");
    expect(stateOf(sessionId)).toBe("provisioning");
    expect(serviceLogLines).toStrictEqual([]);

    await mkdir(repository);
    execFileSync("git", ["init", "--quiet", repository]);
    await projects.attachClonedProject(projectId, repository);
    await creation.finishProvisioningSessions(projectId);

    expect(stateOf(sessionId)).toBe("active");
    expect(eventTypesOf(sessionId)).toStrictEqual([
      "session.created",
      "workspace.preparing",
      "session.activated",
    ]);
  });

  it("removes at start the workspace of a chat never born, keeping one still being created", async () => {
    const unbornId = mintUuidV7() as SessionId;
    await new ManagedWorkspaceService({ homeDirectory: home, repoMounts: mounts }).create({
      sessionId: unbornId,
    });
    // The chat being created holds at its session.created, its workspace already made.
    const createdReached = Promise.withResolvers<void>();
    const createdReleased = Promise.withResolvers<void>();
    const holding = creationWith({
      events: {
        append: async (envelope, options) => {
          if (envelope.type === "session.created") {
            createdReached.resolve();
            await createdReleased.promise;
          }
          return log.eventLog.append(envelope, options);
        },
      },
    });
    const creating = createChat(holding);
    await createdReached.promise;

    await holding.finishStoppedCreates();
    createdReleased.resolve();
    const { sessionId } = await creating;

    expect(await readdir(managedWorkspacesDirectoryOf(home))).toStrictEqual([sessionId]);
    expect(countRows("SELECT COUNT(*) AS count FROM repo_mounts")).toBe(1);
    expect(stateOf(sessionId)).toBe("active");
  });

  it("refuses a project that does not exist, with nothing written", async () => {
    await expect(
      creation.create(projectRequest(mintUuidV7() as ProjectId)),
    ).rejects.toMatchObject({ code: "repo.not_found" });
    expect(countRows("SELECT COUNT(*) AS count FROM sessions")).toBe(0);
    expect(countRows("SELECT COUNT(*) AS count FROM session_events")).toBe(0);
  });

  it("runs the lead on the account made current while its session.created was on its way", async () => {
    const movedAccountId = "claude-personal-account";
    let hasMoved = false;
    const movingEvents: Pick<EventLogService, "append"> = {
      append: async (envelope, options) => {
        if (!hasMoved) {
          hasMoved = true;
          const now = new Date().toISOString();
          await log.scratch.writer.write([
            { sql: "UPDATE provider_accounts SET is_default = 0", bindings: [] },
            {
              sql: `INSERT INTO provider_accounts
                      (account_id, provider, credential_home_path, billing_mode, is_default,
                       created_at, updated_at)
                    VALUES (?, 'claude', ?, 'subscription', 1, ?, ?)`,
              bindings: [movedAccountId, path.join(home, "personal-home"), now, now],
            },
          ]);
        }
        return log.eventLog.append(envelope, options);
      },
    };

    const { sessionId, lead } = await createChat(creationWith({ events: movingEvents }));

    expect(lead.providerAccountId).toBe(movedAccountId);
    expect(createdPayloadOf(sessionId).mainAgent.binding.providerAccountId).toBe(movedAccountId);
  });

  it("reports both failures when the workspace of a chat not born cannot be removed", async () => {
    const creationError = new Error("the disk is full");
    const removalError = new Error("the folder is held open");
    const failing = creationWith({
      events: { append: () => Promise.reject(creationError) },
      removeWorkspace: () => Promise.reject(removalError),
    });

    const refusal = createChat(failing);

    await expect(refusal).rejects.toBeInstanceOf(AggregateError);
    await expect(refusal).rejects.toMatchObject({ errors: [creationError, removalError] });
  });

  it("answers the session when the last pick cannot be kept, and logs why", async () => {
    const keeping = creationWith({
      updateSettings: () => Promise.reject(new Error("the settings file is read-only")),
    });

    const { sessionId, state } = await createChat(keeping);

    expect(state).toBe("active");
    expect(serviceLogLines).toHaveLength(1);
    expect(serviceLogLines[0]).toContain("the settings file is read-only");
    expect(new SessionService(log.scratch.reader).readSession({ sessionId }).session.state).toBe(
      "active",
    );
  });

  it("refuses a group of another project with nothing written", async () => {
    const { projectId } = await attachProject();
    const groupId = await insertGroup(mintUuidV7());

    const refusal = creation.create(projectRequest(projectId, groupId));

    await expect(refusal).rejects.toBeInstanceOf(DaemonDomainError);
    await expect(refusal).rejects.toMatchObject({ code: "session.group_refused" });
    expect(countRows("SELECT COUNT(*) AS count FROM sessions")).toBe(0);
    expect(countRows("SELECT COUNT(*) AS count FROM session_events")).toBe(0);
  });

  it("activates a session outside a group ungrouped while it was being created", async () => {
    const { projectId } = await attachProject();
    const groupId = await insertGroup(projectId);
    // The ungroup lands after the session.created write held the group, before the activation.
    const ungroupingEvents: Pick<EventLogService, "append"> = {
      append: async (envelope, options) => {
        if (envelope.type === "session.activated") {
          await log.scratch.writer.write([
            { sql: "DELETE FROM session_groups WHERE id = ?", bindings: [groupId] },
          ]);
        }
        return log.eventLog.append(envelope, options);
      },
    };

    const { sessionId, state } = await creationWith({ events: ungroupingEvents }).create(
      projectRequest(projectId, groupId),
    );

    expect(state).toBe("active");
    expect(
      log.scratch.reader
        .prepare("SELECT state, group_id FROM sessions WHERE id = ?")
        .get(sessionId),
    ).toStrictEqual({ state: "active", group_id: null });
  });
});

async function attachProject(): Promise<{ projectId: ProjectId; repoMountId: RepoMountId }> {
  const repository = path.join(home, "project");
  await mkdir(repository);
  execFileSync("git", ["init", "--quiet", repository]);
  const { projects } = buildTestProjectService({
    database: log.scratch,
    mounts,
    worktreesDirectory: path.join(home, "worktrees"),
  });
  return projects.attachOrFind({ localPath: repository });
}

// A group of the project `projectId` names; answers its id.
async function insertGroup(projectId: string): Promise<string> {
  const groupId = mintUuidV7();
  await log.scratch.writer.write([
    {
      sql: `INSERT INTO session_groups (id, project_id, name, name_folded, created_at)
            VALUES (?, ?, 'Billing', 'billing', ?)`,
      bindings: [groupId, projectId, new Date().toISOString()],
    },
  ]);
  return groupId;
}

function projectRequest(projectId: ProjectId, groupId?: string): SessionCreateRequest {
  return {
    clientIdempotencyKey: mintUuidV7(),
    binding: {
      kind: "project",
      projectId,
      executionMode: "bound-root",
    },
    lead: SENT_LEAD,
    ...(groupId === undefined ? {} : { groupId: groupId as SessionCreateRequest["groupId"] }),
  };
}
