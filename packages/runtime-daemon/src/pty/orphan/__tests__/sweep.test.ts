// The start's sweep kills a leftover child only on proof it is that child or its own, and otherwise
// discards the entry with nothing signaled: an entry from another boot, a process with the recorded
// id but another start, a process that changed before its signal, and a registry file that cannot
// be trusted are all left alone.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";

import { ORPHAN_REGISTRY_FILE_NAME, OrphanRegistry } from "../registry.js";
import type { OrphanRegistryEntry } from "../registry.js";
import { sweepOrphans, type OrphanSweepSystem } from "../sweep.js";

const BOOT = "boot-now";
const SHELL: ProcessIdentity = { processId: 4100, bootId: BOOT, processStartTime: "Mon Oct  5" };
const DESCENDANTS: ProcessIdentity[] = [4101, 4102].map((processId) => ({
  processId,
  bootId: BOOT,
  processStartTime: "Mon Oct  5",
}));
// A process that left the shell's tree but still carries its nonce.
const DETACHED: ProcessIdentity = { processId: 4200, bootId: BOOT, processStartTime: "Mon Oct  5" };

interface SweptSystem {
  system: OrphanSweepSystem;
  killed: number[];
  identityReads: number[];
}

// `running` answers each identity read in turn, so a test can change a process between reads;
// `carriers` maps each process id to the nonce its environment carries.
function systemWith(
  running: () => readonly ProcessIdentity[],
  carriers: ReadonlyMap<number, string> = new Map(),
): SweptSystem {
  const killed: number[] = [];
  const identityReads: number[] = [];
  return {
    killed,
    identityReads,
    system: {
      bootId: BOOT,
      readProcessIdentity: (processId) => {
        identityReads.push(processId);
        return Promise.resolve(running().find((process) => process.processId === processId));
      },
      findProcessesCarryingNonces: (nonces) =>
        Promise.resolve(new Map([...carriers].filter(([, nonce]) => nonces.has(nonce)))),
      listDescendants: (processId) =>
        Promise.resolve(processId === SHELL.processId ? DESCENDANTS.map((d) => d.processId) : []),
      killProcess: (processId) => {
        killed.push(processId);
      },
    },
  };
}

const startedEntry = (bootId: string, processStartTime: string): OrphanRegistryEntry => ({
  nonce: "nonce-started",
  bootId,
  child: { processId: SHELL.processId, processStartTime },
});

describe("sweepOrphans", () => {
  it("kills a leftover child and its tree when its boot, id and start all match", async () => {
    const { system, killed } = systemWith(() => [SHELL, ...DESCENDANTS]);

    const result = await sweepOrphans(
      { entries: [startedEntry(BOOT, SHELL.processStartTime)] },
      system,
    );

    expect(result).toEqual({ killed: 1, discarded: 0, unreadableCause: undefined });
    expect(killed).toEqual([4101, 4102, SHELL.processId]);
  });

  it("kills a child recorded only by its intent through its nonce", async () => {
    const { system, killed } = systemWith(
      () => [SHELL, ...DESCENDANTS],
      new Map([[SHELL.processId, "nonce-carried"]]),
    );

    const result = await sweepOrphans(
      {
        entries: [
          { nonce: "nonce-carried", bootId: BOOT },
          { nonce: "nonce-never-started", bootId: BOOT },
        ],
      },
      system,
    );

    expect(result).toMatchObject({ killed: 1, discarded: 1 });
    expect(killed).toEqual([4101, 4102, SHELL.processId]);
  });

  it("kills a recorded child's tree and a process that left it carrying its nonce", async () => {
    const { system, killed } = systemWith(
      () => [SHELL, ...DESCENDANTS, DETACHED],
      new Map([
        [SHELL.processId, "nonce-started"],
        [DETACHED.processId, "nonce-started"],
      ]),
    );

    const result = await sweepOrphans(
      { entries: [startedEntry(BOOT, SHELL.processStartTime)] },
      system,
    );

    expect(result).toMatchObject({ killed: 1, discarded: 0 });
    expect(killed).toEqual([4101, 4102, SHELL.processId, DETACHED.processId]);
  });

  it("discards an entry whose id now names a process with another start", async () => {
    const { system, killed } = systemWith(() => [SHELL]);

    const result = await sweepOrphans({ entries: [startedEntry(BOOT, "Sun Oct  4")] }, system);

    expect(result).toMatchObject({ killed: 0, discarded: 1 });
    expect(killed).toEqual([]);
  });

  it("leaves alone a descendant whose id names another process by its signal", async () => {
    // The second read of 4102, right before its signal, finds a process started later.
    const swept: SweptSystem = systemWith(() => [
      SHELL,
      DESCENDANTS[0]!,
      {
        ...DESCENDANTS[1]!,
        processStartTime:
          swept.identityReads.filter((processId) => processId === 4102).length > 1
            ? "Tue Oct  6"
            : "Mon Oct  5",
      },
    ]);

    const result = await sweepOrphans(
      { entries: [startedEntry(BOOT, SHELL.processStartTime)] },
      swept.system,
    );

    expect(result).toMatchObject({ killed: 1, discarded: 0 });
    expect(swept.killed).toEqual([4101, SHELL.processId]);
  });

  it("discards every entry of another boot without reading or signaling any process", async () => {
    const { system, killed, identityReads } = systemWith(
      () => [SHELL, ...DESCENDANTS],
      new Map([[SHELL.processId, "nonce-carried"]]),
    );

    const result = await sweepOrphans(
      {
        entries: [
          startedEntry("boot-before", SHELL.processStartTime),
          { nonce: "nonce-carried", bootId: "boot-before" },
        ],
      },
      system,
    );

    expect(result).toMatchObject({ killed: 0, discarded: 2 });
    expect(killed).toEqual([]);
    expect(identityReads).toEqual([]);
  });

  it("discards a registry file it cannot parse, says why, and signals nothing", async () => {
    const dataFolder = await mkdtemp(path.join(tmpdir(), "orphan-sweep-"));
    try {
      await writeFile(path.join(dataFolder, ORPHAN_REGISTRY_FILE_NAME), '{"entries": [{"nonce":');
      const { system, killed } = systemWith(() => [SHELL]);

      const result = await sweepOrphans(
        await new OrphanRegistry(dataFolder).readLeftover(),
        system,
      );

      expect(result).toMatchObject({ killed: 0, discarded: 0 });
      expect(result.unreadableCause).toMatch(/^it is not JSON/);
      expect(killed).toEqual([]);
    } finally {
      await rm(dataFolder, { recursive: true, force: true });
    }
  });
});
