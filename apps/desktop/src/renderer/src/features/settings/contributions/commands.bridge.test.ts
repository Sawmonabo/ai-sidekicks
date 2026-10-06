// The palette's bridge-backed commands. A refused act is rendered, not dropped; the cases run
// against the fixture bridge, whose `native.copyToClipboard` resolves, with that member made to
// reject or throw where a case needs the failure.

import { describe, expect, it } from "vitest";
import type { ClipboardContent } from "#shared/preload-api.js";
import { createFixtureBridge } from "#renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import type { Refusal } from "#renderer/lib/refusal/refusal.js";
import type { CommandDefinition } from "#renderer/registries/commands/types.js";
import { buildBridgeCommands } from "./commands.js";
import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";

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
    // The palette drops the promise `invoke` returns, so a `run` that let this reject would show
    // the person nothing.
    const bridge = fixtureBridge();
    const rejecting: PlatformBridge = {
      ...bridge,
      native: {
        ...bridge.native,
        copyToClipboard: () => Promise.reject(new Error("the clipboard is unreachable")),
      },
    };
    const refusals: Refusal[] = [];
    const commands = buildBridgeCommands(rejecting, (refusal) => refusals.push(refusal));

    await commandById(commands, "bridge.copyBuildDetails").run();

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe("clipboard-unavailable");
    expect(refusals[0]?.origin).toBe("palette-bridge-command");
    expect(refusals[0]?.detail).toContain("build details could not be copied");
  });

  it("routes a bridge that THROWS to the same sink as one that rejects", async () => {
    // A member that throws synchronously must land on the same sink as one that rejects.
    // Negative control for a boundary attached to the returned promise, which the throw would
    // escape.
    const bridge = fixtureBridge();
    const throwing: PlatformBridge = {
      ...bridge,
      native: {
        ...bridge.native,
        copyToClipboard: () => {
          throw new Error("the clipboard is unreachable");
        },
      },
    };
    const refusals: Refusal[] = [];
    const commands = buildBridgeCommands(throwing, (refusal) => refusals.push(refusal));

    await expect(commandById(commands, "bridge.copyBuildDetails").run()).resolves.toBeUndefined();

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe("clipboard-unavailable");
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
    let copied: ClipboardContent | undefined;
    const bridge = fixtureBridge();
    const instrumented: PlatformBridge = {
      ...bridge,
      native: {
        ...bridge.native,
        copyToClipboard: async (content) => {
          copied = content;
        },
      },
    };
    const commands = buildBridgeCommands(instrumented, () => undefined);

    await commandById(commands, "bridge.copyBuildDetails").run();

    const { version, platform, arch, locale } = bridge.app;
    expect(copied).toStrictEqual({
      text: `AI Sidekicks ${version} — ${platform}/${arch} — ${locale}`,
    });
  });
});
