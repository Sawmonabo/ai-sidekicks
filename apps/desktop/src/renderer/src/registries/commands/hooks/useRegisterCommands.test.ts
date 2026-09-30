// Rows are in the registry while the component is mounted; a contribution signals the palette,
// and a stale mount's teardown never clears a live one's rows.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CommandRegistry } from "../command-registry.js";
import {
  CommandContributionRegistry,
  subscribeToCommandContributions,
} from "../command-contributions.js";
import { commandRegistry } from "../window-command-registry.js";
import { useRegisterCommands } from "./useRegisterCommands.js";
import type { CommandDefinition } from "../command-types.js";

const OWNER = "command-registration-test";

/** A command that does nothing; the suite is about registration. */
function command(id: string): CommandDefinition {
  return {
    id,
    title: `Do ${id}`,
    group: "Suite",
    run: () => undefined,
  };
}

/** The ids this window holds under the suite's own namespace. */
function registeredSuiteIds(): readonly string[] {
  return commandRegistry
    .all()
    .map((entry) => entry.id)
    .filter((id) => id.startsWith("suite."));
}

describe("a component's command registration", () => {
  it("registers on mount and removes on unmount", () => {
    const commands = [command("suite.one"), command("suite.two")];
    const mounted = renderHook(() => {
      useRegisterCommands(OWNER, commands);
    });

    expect(registeredSuiteIds()).toEqual(["suite.one", "suite.two"]);

    mounted.unmount();

    expect(registeredSuiteIds()).toEqual([]);
  });

  it("tells the palette its list changed, so an open palette re-reads", () => {
    let signals = 0;
    const stopWatching = subscribeToCommandContributions(() => {
      signals += 1;
    });
    const commands = [command("suite.signaled")];
    const mounted = renderHook(() => {
      useRegisterCommands(OWNER, commands);
    });

    // `registerCommands` would add the row and tell nobody, leaving an open palette stale.
    expect(signals).toBeGreaterThan(0);

    mounted.unmount();
    stopWatching();
  });

  it("replaces its own rows rather than raising on a duplicate id", () => {
    const first = renderHook(
      ({ commands }: { commands: readonly CommandDefinition[] }) => {
        useRegisterCommands(OWNER, commands);
      },
      { initialProps: { commands: [command("suite.one")] } },
    );

    first.rerender({ commands: [command("suite.one"), command("suite.two")] });

    expect(registeredSuiteIds()).toEqual(["suite.one", "suite.two"]);

    first.unmount();
  });

  it("leaves a live component's rows alone when a superseded mount tears down", () => {
    // The second mount arrives before the first goes; the first's cleanup must not take the rows.
    const older = renderHook(() => {
      useRegisterCommands(OWNER, [command("suite.older")]);
    });
    const newer = renderHook(() => {
      useRegisterCommands(OWNER, [command("suite.newer")]);
    });

    expect(registeredSuiteIds()).toEqual(["suite.newer"]);

    older.unmount();

    expect(registeredSuiteIds()).toEqual(["suite.newer"]);

    newer.unmount();

    expect(registeredSuiteIds()).toEqual([]);
  });

  it("hands the rows back to the older mount when the newer one closes", () => {
    // The order a person performs: close the pane opened last; the older pane must keep its acts.
    const older = renderHook(() => {
      useRegisterCommands(OWNER, [command("suite.older")]);
    });
    const newer = renderHook(() => {
      useRegisterCommands(OWNER, [command("suite.newer")]);
    });

    newer.unmount();

    expect(registeredSuiteIds()).toEqual(["suite.older"]);

    older.unmount();

    expect(registeredSuiteIds()).toEqual([]);
  });

  it("restores through three mounts, in either closing order", () => {
    // Three mounts, because two cannot tell "restore the next one down" from "restore the first".
    const first = renderHook(() => {
      useRegisterCommands(OWNER, [command("suite.first")]);
    });
    const second = renderHook(() => {
      useRegisterCommands(OWNER, [command("suite.second")]);
    });
    const third = renderHook(() => {
      useRegisterCommands(OWNER, [command("suite.third")]);
    });

    second.unmount();

    expect(registeredSuiteIds()).toEqual(["suite.third"]);

    third.unmount();

    expect(registeredSuiteIds()).toEqual(["suite.first"]);

    first.unmount();

    expect(registeredSuiteIds()).toEqual([]);
  });
});

describe("the live-contributor register belongs to the composition, not to the module", () => {
  it("two compositions do not see each other's rows, nor disarm each other's release", () => {
    // A second composition under the same owner must not supersede the first's release.
    const firstRegistry = new CommandRegistry();
    const secondRegistry = new CommandRegistry();
    const first = new CommandContributionRegistry(firstRegistry);
    const second = new CommandContributionRegistry(secondRegistry);

    const releaseFirst = first.contribute({
      owner: OWNER,
      commands: [command("suite.first")],
      keyBindings: [],
    });
    second.contribute({ owner: OWNER, commands: [command("suite.second")], keyBindings: [] });

    expect(firstRegistry.all().map((entry) => entry.id)).toEqual(["suite.first"]);
    expect(secondRegistry.all().map((entry) => entry.id)).toEqual(["suite.second"]);

    releaseFirst();

    expect(firstRegistry.all()).toEqual([]);
    expect(secondRegistry.all().map((entry) => entry.id)).toEqual(["suite.second"]);
  });

  it("a superseded contributor's release is a no-op within one composition", () => {
    const registry = new CommandRegistry();
    const contributions = new CommandContributionRegistry(registry);

    const releaseOlder = contributions.contribute({
      owner: OWNER,
      commands: [command("suite.older")],
      keyBindings: [],
    });
    contributions.contribute({
      owner: OWNER,
      commands: [command("suite.newer")],
      keyBindings: [],
    });

    releaseOlder();

    expect(registry.all().map((entry) => entry.id)).toEqual(["suite.newer"]);
  });

  it("restores the older contributor's CHORDS too, not only its commands", () => {
    // Commands and chords leave and return together; a chord for a missing command does nothing.
    const registry = new CommandRegistry();
    const contributions = new CommandContributionRegistry(registry);

    contributions.contribute({
      owner: OWNER,
      commands: [command("suite.older")],
      keyBindings: [{ chord: "$mod+Shift+1", commandId: "suite.older" }],
    });
    const releaseNewer = contributions.contribute({
      owner: OWNER,
      commands: [command("suite.newer")],
      keyBindings: [{ chord: "$mod+Shift+2", commandId: "suite.newer" }],
    });

    releaseNewer();

    expect(contributions.keyBindings()).toEqual([
      { chord: "$mod+Shift+1", commandId: "suite.older" },
    ]);
    expect(registry.all().map((entry) => entry.id)).toEqual(["suite.older"]);
  });

  it("negative control: releasing one contribution twice does not withdraw the restored one", () => {
    // Guards removal by identity rather than position: a second call must not take another's rows.
    const registry = new CommandRegistry();
    const contributions = new CommandContributionRegistry(registry);

    contributions.contribute({
      owner: OWNER,
      commands: [command("suite.older")],
      keyBindings: [],
    });
    const releaseNewer = contributions.contribute({
      owner: OWNER,
      commands: [command("suite.newer")],
      keyBindings: [],
    });

    releaseNewer();
    releaseNewer();

    expect(registry.all().map((entry) => entry.id)).toEqual(["suite.older"]);
  });
});
