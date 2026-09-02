// The palette's bridge-backed commands, and the door they reach the bridge through.
//
// Two claims worth proving separately. The BEHAVIOUR — an act that the bridge
// refuses settles as a rendered refusal rather than as a dropped promise — is
// driven against the real fixture bridge, whose `update.requestCheck` genuinely
// rejects and whose `native.copyToClipboard` genuinely resolves, so neither arm is
// a stub answering the way the test wants. The WIRING — that the commands reach the
// bridge through `useConsoleBridge` and through nothing else — needs a React tree,
// and is proved by rendering one.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  type ConsoleBridge,
} from "../bridge/index.js";
import type { ConsoleRefusal } from "../core/index.js";
import type { ConsoleCommand } from "./contributions.js";
import { buildBridgeCommands, useBridgeCommands } from "./bridge-commands.js";
import { FIRST_RUN_SCENARIO } from "../bridge/scenarios/first-run.js";

function fixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
}

function commandById(commands: readonly ConsoleCommand[], commandId: string): ConsoleCommand {
  const command = commands.find((candidate) => candidate.id === commandId);
  if (command === undefined) {
    throw new Error(`the builder produced no command named ${commandId}`);
  }
  return command;
}

describe("palette bridge commands — a refused act is rendered, never dropped", () => {
  it("routes a bridge rejection to the refusal sink", async () => {
    // `update.requestCheck` has no fixture stand-in and rejects. The palette drops
    // the promise `invoke` hands back, so a `run` that let this reject would raise
    // an unhandled rejection and show the person nothing at all.
    const refusals: ConsoleRefusal[] = [];
    const commands = buildBridgeCommands(fixtureBridge(), (refusal) => refusals.push(refusal));

    await commandById(commands, "bridge.checkForUpdates").run();

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe("update-check-unavailable");
    expect(refusals[0]?.origin).toBe("palette-bridge-command");
    expect(refusals[0]?.detail).toContain("update check could not start");
  });

  it("does not reject, so the palette's fire-and-forget dispatch is safe", async () => {
    const commands = buildBridgeCommands(fixtureBridge(), () => undefined);

    await expect(commandById(commands, "bridge.checkForUpdates").run()).resolves.toBeUndefined();
  });

  it("negative control: an act the bridge serves reports no refusal", async () => {
    // Without this, a sink that was called on every path — or an assertion that
    // never checked emptiness — would make the case above pass for the wrong
    // reason. The fixture's clipboard write resolves, so this arm must stay silent.
    const refusals: ConsoleRefusal[] = [];
    const commands = buildBridgeCommands(fixtureBridge(), (refusal) => refusals.push(refusal));

    await commandById(commands, "bridge.copyBuildDetails").run();

    expect(refusals).toStrictEqual([]);
  });

  it("copies the meta the bridge reports rather than the host's own", async () => {
    // The command must read `app` off the bridge: under the fixture that meta is
    // pinned, which is what keeps a screenshot of the result stable. A command that
    // read `navigator` would pass every assertion above and still be wrong.
    let copied: string | undefined;
    const bridge = fixtureBridge();
    const instrumented: ConsoleBridge = {
      ...bridge,
      sidekicks: {
        ...bridge.sidekicks,
        native: {
          ...bridge.sidekicks.native,
          copyToClipboard: async (text: string) => {
            copied = text;
          },
        },
      },
    };
    const commands = buildBridgeCommands(instrumented, () => undefined);

    await commandById(commands, "bridge.copyBuildDetails").run();

    const { version, platform, arch, locale } = bridge.sidekicks.app;
    expect(copied).toBe(`AI Sidekicks ${version} — ${platform}/${arch} — ${locale}`);
  });
});

describe("palette bridge commands — the hook reaches the bridge through the provider", () => {
  it("builds its commands from the bridge the provider resolved", async () => {
    let seen: readonly ConsoleCommand[] = [];

    function CommandProbe(): React.JSX.Element {
      seen = useBridgeCommands(() => undefined);
      return <span>{String(seen.length)}</span>;
    }

    await act(async () => {
      render(
        <SidekicksBridgeProvider bridge={fixtureBridge()}>
          <CommandProbe />
        </SidekicksBridgeProvider>,
      );
    });

    expect(seen.map((command) => command.id)).toStrictEqual([
      "bridge.copyBuildDetails",
      "bridge.checkForUpdates",
    ]);
  });

  it("negative control: refuses to build outside the provider", async () => {
    // `useConsoleBridge` throws rather than returning `undefined`, so a surface
    // mounted outside the provider is a wiring bug that surfaces at once instead of
    // rendering an empty palette that looks like "no commands apply here".
    function OrphanProbe(): React.JSX.Element {
      useBridgeCommands(() => undefined);
      return <span />;
    }

    await expect(
      act(async () => {
        render(<OrphanProbe />);
      }),
    ).rejects.toThrow(/SidekicksBridgeProvider/);
  });
});
