// The palette's bridge-backed commands. A refused act is rendered, not dropped; the cases run
// against the fixture bridge, whose `update.requestCheck` rejects and whose
// `native.copyToClipboard` resolves.

import { describe, expect, it } from "vitest";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { Refusal } from "@renderer/lib/refusal.js";
import type { CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { buildBridgeCommands } from "./commands.js";
import { FIRST_RUN_SCENARIO } from "@fixtures/scenarios/first-run.js";

function fixtureBridge(): PlatformBridge {
  return createFixtureBridge({ scenario: FIRST_RUN_SCENARIO }).bridge;
}

function commandById(commands: readonly CommandDefinition[], commandId: string): CommandDefinition {
  const command = commands.find((candidate) => candidate.id === commandId);
  if (command === undefined) {
    throw new Error(`the builder produced no command named ${commandId}`);
  }
  return command;
}

describe("palette bridge commands — a refused act is rendered, never dropped", () => {
  it("routes a bridge rejection to the refusal sink", async () => {
    // `update.requestCheck` has no fixture stand-in and rejects. The palette drops the promise
    // `invoke` returns, so a `run` that let this reject would show the person nothing.
    const refusals: Refusal[] = [];
    const commands = buildBridgeCommands(fixtureBridge(), (refusal) => refusals.push(refusal));

    await commandById(commands, "bridge.checkForUpdates").run();

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe("update-check-unavailable");
    expect(refusals[0]?.origin).toBe("palette-bridge-command");
    expect(refusals[0]?.detail).toContain("update check could not start");
  });

  it("routes a bridge that THROWS to the same sink as one that rejects", async () => {
    // A preload member main has not wired throws synchronously, while the fixture refuses with
    // a rejected promise; both must land on one sink. Negative control for a boundary attached
    // to the returned promise, which the throw would escape.
    const bridge = fixtureBridge();
    const throwing: PlatformBridge = {
      ...bridge,
      update: {
        ...bridge.update,
        requestCheck: () => {
          throw new Error("update.requestCheck is not implemented");
        },
      },
    };
    const refusals: Refusal[] = [];
    const commands = buildBridgeCommands(throwing, (refusal) => refusals.push(refusal));

    await expect(commandById(commands, "bridge.checkForUpdates").run()).resolves.toBeUndefined();

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe("update-check-unavailable");
  });

  it("negative control: an act the bridge serves reports no refusal", async () => {
    // Guards against a sink called on every path, or an assertion that never checked emptiness.
    // The fixture's clipboard write resolves, so this arm must stay silent.
    const refusals: Refusal[] = [];
    const commands = buildBridgeCommands(fixtureBridge(), (refusal) => refusals.push(refusal));

    await commandById(commands, "bridge.copyBuildDetails").run();

    expect(refusals).toStrictEqual([]);
  });

  it("copies the meta the bridge reports rather than the host's own", async () => {
    // The command must read `app` off the bridge: the fixture pins that meta, and a command
    // reading `navigator` would pass every assertion above.
    let copied: string | undefined;
    const bridge = fixtureBridge();
    const instrumented: PlatformBridge = {
      ...bridge,
      native: {
        ...bridge.native,
        copyToClipboard: async (text: string) => {
          copied = text;
        },
      },
    };
    const commands = buildBridgeCommands(instrumented, () => undefined);

    await commandById(commands, "bridge.copyBuildDetails").run();

    const { version, platform, arch, locale } = bridge.app;
    expect(copied).toBe(`AI Sidekicks ${version} — ${platform}/${arch} — ${locale}`);
  });
});
