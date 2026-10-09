// Cloning with real git over a real database, from repositories made in a scratch folder: a
// destination that holds anything is refused before git starts; git's questions reach the card
// through the askpass program and the answers go back to git and nowhere else; a canceled clone
// leaves no folder; a clone lost to a restart has the folder the daemon made for it removed at the
// next start, while the person's folder at the destination, a canceled clone's or one the daemon
// made no folder for, is never touched. Git runs with no system or global config, so no credential
// helper of the person's is asked or written.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProjectId } from "@ai-sidekicks/contracts/project";
import {
  REPO_CLONE_REFUSED_CODE,
  type CloneQuestionId,
  type RepoCloneQuestion,
  type RepoCloneStatus,
} from "@ai-sidekicks/contracts/repo/clone";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";

import {
  openSessionLog,
  type SessionLog,
} from "../../../session/directory/__fixtures__/event-log.js";
import {
  createGitCommand,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  createGitRunner,
} from "../../../git/process.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import { WorkspaceEventEmitter } from "../../event-emitter.js";
import type { ProjectRecords } from "../../project/records.js";
import type { ProjectService } from "../../project/service.js";
import { buildTestProjectService } from "../../project/service.test-support.js";
import { RepoMountService } from "../../repo/mount-service.js";
import { AskpassBroker } from "../askpass/broker.js";
import { makeStagedClone } from "../destination.js";
import { CloneService } from "../service.js";
import { createStreamedGitRunner } from "../streamed-git.js";

const PASSWORD = "s3cret-typed-by-the-person";

// A clone through real git and the askpass program, which starts Node once per question.
const REAL_GIT_TIMEOUT_MS = 30_000;

// The variables a test sets so git reads no system or global config and reaches the scratch
// server without a proxy.
const CONFIG_VARIABLES = [
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "NO_PROXY",
  "no_proxy",
] as const;

let log: SessionLog;
let home: string;
let parentFolder: string;
let projects: ProjectService;
let records: ProjectRecords;
let broker: AskpassBroker;
let serviceLogLines: string[];
let savedConfig: Partial<Record<(typeof CONFIG_VARIABLES)[number], string>>;
let server: Server | undefined;

beforeEach(async () => {
  savedConfig = {};
  for (const name of CONFIG_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) savedConfig[name] = value;
  }
  log = await openSessionLog();
  home = await mkdtemp(path.join(tmpdir(), "aisk-clone-"));
  parentFolder = path.join(home, "code");
  await mkdir(parentFolder);
  const emptyConfig = path.join(home, "gitconfig");
  await writeFile(emptyConfig, "");
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  process.env["GIT_CONFIG_GLOBAL"] = emptyConfig;
  process.env["NO_PROXY"] = "127.0.0.1";
  process.env["no_proxy"] = "127.0.0.1";
  serviceLogLines = [];
  const mounts = new RepoMountService({
    database: log.scratch,
    events: new WorkspaceEventEmitter({ sessionEvents: log.eventLog }),
    nodeId: mintUuidV7() as NodeId,
  });
  ({ projects, records } = buildTestProjectService({
    database: log.scratch,
    mounts,
    worktreesDirectory: path.join(home, "worktrees"),
    serviceLogLines,
  }));
  broker = await AskpassBroker.start((line) => serviceLogLines.push(line));
});

afterEach(async () => {
  await broker.close();
  const signIn = server;
  if (signIn !== undefined) {
    signIn.closeAllConnections();
    await new Promise<void>((resolve) => {
      signIn.close(() => {
        resolve();
      });
    });
  }
  server = undefined;
  await log.scratch.close();
  await rm(home, { recursive: true, force: true });
  for (const name of CONFIG_VARIABLES) {
    const value = savedConfig[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function cloneService(gitExecutablePath = "git"): CloneService {
  return new CloneService({
    projects,
    records,
    askpass: broker,
    readCloneFolderSetting: () => Promise.resolve(parentFolder),
    homeDirectory: home,
    folderPlace: { isInAnotherDistribution: () => false },
    git: createGitCommand({
      git: createGitRunner(gitExecutablePath),
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    }),
    streamedGit: createStreamedGitRunner(gitExecutablePath),
    onCloneAttached: () => Promise.resolve(),
    writeServiceLog: (line) => serviceLogLines.push(line),
  });
}

// A repository with one commit and the given files, made in the scratch folder.
function sourceRepository(name: string, files: Readonly<Record<string, string>>): string {
  const repository = path.join(home, "sources", name);
  execFileSync("git", ["init", "--quiet", repository]);
  for (const [file, text] of Object.entries(files)) {
    execFileSync("sh", ["-c", 'printf "%s" "$2" > "$1"', "sh", path.join(repository, file), text]);
  }
  execFileSync("git", ["-C", repository, "add", "--all"]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Ana",
    "-c",
    "user.email=ana@example.com",
    "commit",
    "--quiet",
    "--message=first",
  ]);
  return repository;
}

// An HTTP server that asks for a sign-in on every request and accepts none, so git waits on its
// questions until they are answered or the clone is stopped.
async function signInServer(seen: IncomingMessage[]): Promise<string> {
  const signIn = createServer((request, response) => {
    seen.push(request);
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="scratch"' });
    response.end();
  });
  server = signIn;
  await new Promise<void>((resolve) => signIn.listen(0, "127.0.0.1", resolve));
  const { port } = signIn.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}/team/billing-api.git`;
}

/** A clone card a test follows. */
interface FollowedCard {
  readonly statuses: RepoCloneStatus[];
  /** Waits for the first status `matches` accepts. */
  waitFor(matches: (status: RepoCloneStatus) => boolean): Promise<RepoCloneStatus>;
}

// The card's statuses as they arrive.
async function followCard(clones: CloneService, projectId: ProjectId): Promise<FollowedCard> {
  const statuses: RepoCloneStatus[] = [];
  const waiters: (() => void)[] = [];
  const { status } = await clones.subscribe(projectId, (update) => {
    statuses.push(update);
    for (const wake of waiters.splice(0)) wake();
  });
  // Updates arrive on later turns, so the opening status is the first.
  statuses.unshift(status);
  return {
    statuses,
    waitFor: async (matches) => {
      for (;;) {
        const found = statuses.find(matches);
        if (found !== undefined) return found;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

function storedText(): string {
  const rows = log.scratch.reader.prepare("SELECT * FROM projects").all();
  return JSON.stringify(rows) + serviceLogLines.join("\n");
}

describe("starting a clone", () => {
  it("refuses a destination holding anything before git starts, writing nothing", async () => {
    const source = sourceRepository("billing-api", { "README.md": "hello" });
    await mkdir(path.join(parentFolder, "billing-api"));
    await writeFile(path.join(parentFolder, "billing-api", "notes.txt"), "mine");
    // A git that cannot run: any git start would fail differently.
    const clones = cloneService(path.join(home, "no-such-git"));

    await expect(clones.clone({ url: `file://${source}`, parentFolder })).rejects.toMatchObject({
      code: REPO_CLONE_REFUSED_CODE,
      detail: { reason: "destination_not_empty" },
    });

    expect(log.scratch.reader.prepare("SELECT id FROM projects").all()).toStrictEqual([]);
    expect(await readdir(path.join(parentFolder, "billing-api"))).toStrictEqual(["notes.txt"]);
  });
});

describe("git's questions", () => {
  it(
    "reach the card, masked for a password, and the answers reach git alone",
    { timeout: REAL_GIT_TIMEOUT_MS },
    async () => {
      const seen: IncomingMessage[] = [];
      const url = await signInServer(seen);
      const clones = cloneService();
      const { projectId } = await clones.clone({ url, parentFolder });
      const card = await followCard(clones, projectId);

      const userName = await card.waitFor((status) => questionOf(status)?.masked === false);
      clones.answer(projectId, questionIdOf(userName), "ana");
      const password = await card.waitFor((status) => questionOf(status)?.masked === true);
      expect(questionOf(password)?.prompt).toMatch(/^Password for 'http:\/\/ana@127\.0\.0\.1/);
      clones.answer(projectId, questionIdOf(password), PASSWORD);
      const failed = await card.waitFor((status) => status.state === "failed");

      expect(failed).toMatchObject({ state: "failed", step: "clone" });
      expect(seen.map((request) => request.headers.authorization)).toContain(
        `Basic ${Buffer.from(`ana:${PASSWORD}`).toString("base64")}`,
      );
      expect(storedText()).not.toContain(PASSWORD);
      expect(JSON.stringify(card.statuses)).not.toContain(PASSWORD);
    },
  );
});

describe("canceling a clone", () => {
  it("stops git and leaves no folder behind", { timeout: REAL_GIT_TIMEOUT_MS }, async () => {
    const url = await signInServer([]);
    const clones = cloneService();
    const { projectId } = await clones.clone({ url, parentFolder });
    const card = await followCard(clones, projectId);
    await card.waitFor((status) => questionOf(status) !== null);

    await clones.cancel(projectId);

    await card.waitFor((status) => status.state === "canceled");
    expect(await readdir(parentFolder)).toStrictEqual([]);
    expect(
      log.scratch.reader.prepare("SELECT state, clone_outcome, clone_failure FROM projects").all(),
    ).toStrictEqual([{ state: "cloning", clone_outcome: "canceled", clone_failure: null }]);
  });
});

describe("the next start after a clone", () => {
  it("removes the folder it made for a clone a restart cut short, never the person's", async () => {
    const destination = path.join(parentFolder, "lost");
    const lost = await projects.createCloningProject({
      url: "https://example.com/team/lost.git",
      folderPath: destination,
      name: "lost",
    });
    const staged = await makeStagedClone(destination);
    await projects.recordCloneStaged(lost, staged);
    await mkdir(path.join(staged.path, ".git"));
    await writeFile(path.join(staged.path, ".git", "HEAD"), "ref: refs/heads/main\n");
    // The person clones it by hand after the crash.
    await mkdir(path.join(destination, ".git"), { recursive: true });
    await writeFile(path.join(destination, "notes.txt"), "mine");
    const restarted = cloneService();

    await restarted.recoverInterruptedClones();

    expect(await readdir(parentFolder)).toStrictEqual(["lost"]);
    expect((await readdir(destination)).sort()).toStrictEqual([".git", "notes.txt"]);
    expect((await restarted.subscribe(lost, () => undefined)).status).toStrictEqual({
      projectId: lost,
      state: "failed",
      step: "clone",
      failureLine: null,
    });
  });

  it("keeps a folder the person put where a canceled clone, or one with no folder made, was", async () => {
    const folder = path.join(parentFolder, "billing-api");
    const canceled = await projects.createCloningProject({
      url: "https://example.com/team/billing-api.git",
      folderPath: folder,
      name: "billing-api",
    });
    await projects.recordCloneEnd(canceled, { outcome: "canceled" });
    // A clone the stop cut short before the daemon made its folder.
    const unstartedFolder = path.join(parentFolder, "ledger");
    const unstarted = await projects.createCloningProject({
      url: "https://example.com/team/ledger.git",
      folderPath: unstartedFolder,
      name: "ledger",
    });
    // The person clones each by hand afterward.
    for (const personFolder of [folder, unstartedFolder]) {
      await mkdir(path.join(personFolder, ".git"), { recursive: true });
      await writeFile(path.join(personFolder, "notes.txt"), "mine");
    }

    await cloneService().recoverInterruptedClones();

    expect((await readdir(folder)).sort()).toStrictEqual([".git", "notes.txt"]);
    expect((await readdir(unstartedFolder)).sort()).toStrictEqual([".git", "notes.txt"]);
    expect((await cloneService().subscribe(canceled, () => undefined)).status).toStrictEqual({
      projectId: canceled,
      state: "canceled",
    });
    expect((await cloneService().subscribe(unstarted, () => undefined)).status).toStrictEqual({
      projectId: unstarted,
      state: "failed",
      step: "clone",
      failureLine: null,
    });
  });
});

function questionOf(status: RepoCloneStatus): RepoCloneQuestion | null {
  return status.state === "cloning" ? status.question : null;
}

function questionIdOf(status: RepoCloneStatus): CloneQuestionId {
  const question = questionOf(status);
  if (question === null) throw new Error("the card waits on no question");
  return question.questionId;
}
