// Two mounts under one owner share the rows: the newest one's are registered, and a stale mount's
// teardown never clears a live one's rows.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
