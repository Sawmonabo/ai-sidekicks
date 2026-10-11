// `session.permissionLevelUpdate` through the daemon's method registry: an open session's process
// is moved before the level is stored, so the record never names a level the provider refused; a
// session not open has the level stored alone, and a process that opened while it was stored is
// moved after; the level a session already stands at changes nothing.

import { describe, expect, it } from "vitest";

import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ProviderDriver } from "../../../../provider/driver/contract.js";
import { PermissionLevelUnavailableError } from "../../../../provider/driver/session-control.js";
import type { StreamingPrimitive } from "../../../streaming-primitive.js";
import { MethodRegistryImpl } from "../../../registry.js";
import { registerSessionControlMethods } from "../control.js";

const SESSION_ID = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e" as SessionId;

interface LevelHarness {
  readonly registry: MethodRegistryImpl;
  // Each step in the order it ran: a provider move, a stored level, a process opening.
  readonly steps: string[];
}

function buildLevelHarness(options: {
  readonly stored: PermissionLevel;
  readonly isOpen: boolean;
  readonly opensWhileStored?: boolean;
  readonly refusesMove?: boolean;
}): LevelHarness {
  const steps: string[] = [];
  let stored = options.stored;
  let isOpen = options.isOpen;
  const driver = {
    updatePermissionLevel: async ({ level }: { level: PermissionLevel }) => {
      if (options.refusesMove === true) {
        throw new PermissionLevelUnavailableError(level);
      }
      steps.push(`provider ${level}`);
    },
  } as unknown as ProviderDriver;
  const registry = new MethodRegistryImpl();
  registerSessionControlMethods(registry, {
    providerRegistry: {
      lookup: () => driver,
      checkCapability: () => undefined,
    } as never,
    resolveDriverForSession: () => "claude",
    streamingPrimitive: {} as StreamingPrimitive,
    recordSessionMode: async () => {},
    permissionLevels: {
      read: () => stored,
      record: async (_sessionId, level) => {
        stored = level;
        steps.push(`stored ${level}`);
        if (options.opensWhileStored === true) {
          isOpen = true;
          steps.push("opened");
        }
      },
    },
    providerSessions: {
      isOpen: () => isOpen,
      moveLevel: (_sessionId, level) => {
        steps.push(`runs ${level}`);
      },
    },
  });
  return { registry, steps };
}

async function moveTo(harness: LevelHarness, level: PermissionLevel): Promise<unknown> {
  return await harness.registry.dispatch(
    "session.permissionLevelUpdate",
    { sessionId: SESSION_ID, level },
    {},
  );
}

describe("session.permissionLevelUpdate", () => {
  it("moves an open session's process first, then stores the level", async () => {
    const harness = buildLevelHarness({ stored: "yolo", isOpen: true });

    await expect(moveTo(harness, "ask")).resolves.toStrictEqual({
      sessionId: SESSION_ID,
      level: "ask",
    });

    expect(harness.steps).toStrictEqual(["provider ask", "runs ask", "stored ask"]);
  });

  it("stores nothing when the provider refuses the level", async () => {
    const harness = buildLevelHarness({ stored: "yolo", isOpen: true, refusesMove: true });

    await expect(moveTo(harness, "reviewed")).rejects.toMatchObject({
      code: "session.permission_level_unavailable",
    });

    expect(harness.steps).toStrictEqual([]);
  });

  it("stores the level of a session not open, and moves a process that opened meanwhile", async () => {
    const closed = buildLevelHarness({ stored: "yolo", isOpen: false });
    const opening = buildLevelHarness({ stored: "yolo", isOpen: false, opensWhileStored: true });

    await moveTo(closed, "sandboxed");
    await moveTo(opening, "sandboxed");

    expect(closed.steps).toStrictEqual(["stored sandboxed"]);
    expect(opening.steps).toStrictEqual([
      "stored sandboxed",
      "opened",
      "provider sandboxed",
      "runs sandboxed",
    ]);
  });

  it("changes nothing for the level the session already stands at", async () => {
    const harness = buildLevelHarness({ stored: "ask", isOpen: true });

    await moveTo(harness, "ask");

    expect(harness.steps).toStrictEqual([]);
  });
});
