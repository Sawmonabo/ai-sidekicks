// A terminal child is never outside the orphan registry's view: its intent is on disk, naming the
// nonce its environment carries, before the child is started; a crash right after leaves only an
// intent, which the next start discards with nothing signaled; and a child whose process cannot be
// recorded is killed and its spawn refused.

import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";

import { makeFakeChild } from "../../__fixtures__/child-doubles.js";
import { NodePtyHost, type NodePtySpawnFn } from "../../host/node-pty.js";
import type { SpawnRequest } from "../../host/protocol.js";
import { openOrphanGuard } from "../guard.js";
import { ORPHAN_REGISTRY_FILE_NAME, SPAWN_NONCE_ENVIRONMENT_NAME } from "../registry.js";
import { DARWIN_TERMINAL_OPERATING_SYSTEM } from "../../operating-system/darwin.js";
import { selectTerminalOperatingSystem } from "../../operating-system/selector.js";

const BOOT = "boot-now";
const SHELL_SPAWN: SpawnRequest = {
  kind: "spawn_request",
  command: "/bin/sh",
  args: [],
  env: [["PATH", "/usr/bin:/bin"]],
  cwd: "/tmp",
  rows: 24,
  cols: 80,
};

let dataFolder: string;

beforeEach(async () => {
  dataFolder = await mkdtemp(path.join(tmpdir(), "orphan-guard-"));
});

afterEach(async () => {
  await rm(dataFolder, { recursive: true, force: true });
  expect(serviceLog.splice(0)).toEqual([]);
});

async function readRegistryFile(): Promise<unknown> {
  return JSON.parse(await readFile(path.join(dataFolder, ORPHAN_REGISTRY_FILE_NAME), "utf8"));
}

const serviceLog: string[] = [];

// No process carries a nonce here, so the sweep this opening runs never signals anything.
function openGuard(
  readProcessIdentity: (processId: number) => Promise<ProcessIdentity | undefined>,
): ReturnType<typeof openOrphanGuard> {
  return openOrphanGuard({
    dataFolder,
    bootId: BOOT,
    readProcessIdentity,
    operatingSystem: { findProcessesCarryingNonces: () => Promise.resolve(new Map()) },
    writeServiceLog: (line) => {
      serviceLog.push(line);
    },
  });
}

describe("OrphanGuard", () => {
  it("records the intent before the start, and a crash then leaves it discardable", async () => {
    const { guard } = await openGuard(() => Promise.resolve(undefined));
    let registryAtSpawn: unknown;
    let nonceAtSpawn: string | undefined;
    const { child } = makeFakeChild(4200);
    const ptySpawn: NodePtySpawnFn = (_command, _args, options) => {
      nonceAtSpawn = options.env[SPAWN_NONCE_ENVIRONMENT_NAME];
      // Read in the moment of the start, before anything after it can rewrite the file.
      registryAtSpawn = JSON.parse(
        readFileSync(path.join(dataFolder, ORPHAN_REGISTRY_FILE_NAME), "utf8"),
      );
      return child;
    };

    await new NodePtyHost(guard, selectTerminalOperatingSystem(process.platform, process.env), {
      ptySpawn,
    }).spawn(SHELL_SPAWN);

    expect(nonceAtSpawn).toMatch(/^[0-9a-f]{32}$/);
    expect(registryAtSpawn).toEqual({ entries: [{ nonce: nonceAtSpawn, bootId: BOOT }] });

    // The daemon dies before the child's process is recorded: the intent is all the next start
    // finds, and no process carries its nonce, so it is discarded with nothing signaled.
    await guard.prepareSpawn();
    await guard.close();
    const { sweep } = await openGuard(() => Promise.resolve(undefined));
    expect(sweep).toMatchObject({ killed: 0, discarded: 1 });
    expect(await readRegistryFile()).toEqual({ entries: [] });
  });

  it("kills a child whose process cannot be recorded and refuses its spawn", async () => {
    const { guard } = await openGuard(() => Promise.reject(new Error("ps is unavailable")));
    const { child, triggerExit } = makeFakeChild(4300);
    const groupSignals: Array<[number, NodeJS.Signals]> = [];
    const signalProcessGroup = (leaderId: number, signal: NodeJS.Signals): void => {
      groupSignals.push([leaderId, signal]);
    };

    await expect(
      new NodePtyHost(guard, DARWIN_TERMINAL_OPERATING_SYSTEM, {
        ptySpawn: () => child,
        platform: "darwin",
        signalProcessGroup,
      }).spawn(SHELL_SPAWN),
    ).rejects.toThrow("ps is unavailable");

    expect(groupSignals).toEqual([[4300, "SIGKILL"]]);
    // Its exit retires the intent the spawn wrote.
    triggerExit(0, 9);
    await guard.close();
    expect(await readRegistryFile()).toEqual({ entries: [] });
  });
});
