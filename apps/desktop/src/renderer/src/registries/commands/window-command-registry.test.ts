// The window's command registry and its `when` vocabulary; the runtime tuple and the compiler's
// context type must be one set.

import { describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "@renderer/lib/keyed-registry.js";
import {
  WHEN_CLAUSE_KEYS,
  commandRegistry,
  registerCommands,
  type WindowWhenClauseContext,
} from "./window-command-registry.js";

/** Every published key, all false. */
const NO_CONTEXT: WindowWhenClauseContext = {
  sessionActive: false,
  onSessions: false,
  onSession: false,
  onWorkflows: false,
  onSettings: false,
};

/**
 * The compile-time control: an invented key is an excess-property error. If the type were
 * widened to `Record<string, boolean>`, the directive below would itself become the error.
 */
const CONTEXT_THE_COMPILER_REJECTS: WindowWhenClauseContext = {
  ...NO_CONTEXT,
  // @ts-expect-error — `sessionActiveish` is not a key the console publishes.
  sessionActiveish: false,
};

describe("window command registry — the call commands are registered through", () => {
  it("registers several atomically", () => {
    try {
      registerCommands([
        { id: "console-commands-test.a", title: "A", group: "Test", run: () => undefined },
        { id: "console-commands-test.b", title: "B", group: "Test", run: () => undefined },
      ]);
      expect(commandRegistry.has("console-commands-test.a")).toBe(true);
      expect(commandRegistry.has("console-commands-test.b")).toBe(true);
    } finally {
      commandRegistry.unregister("console-commands-test.a");
      commandRegistry.unregister("console-commands-test.b");
    }
  });

  it("leaves the registry untouched when one id in a batch is taken", () => {
    // Atomicity is why the plural call exists; a half-registered owner cannot be unwound.
    try {
      commandRegistry.register({
        id: "console-commands-test.taken",
        title: "Taken",
        group: "Test",
        run: () => undefined,
      });
      expect(() => {
        registerCommands([
          {
            id: "console-commands-test.fresh",
            title: "Fresh",
            group: "Test",
            run: () => undefined,
          },
          {
            id: "console-commands-test.taken",
            title: "Again",
            group: "Test",
            run: () => undefined,
          },
        ]);
      }).toThrow(DuplicateRegistrationError);
      expect(commandRegistry.has("console-commands-test.fresh")).toBe(false);
    } finally {
      commandRegistry.unregister("console-commands-test.taken");
      commandRegistry.unregister("console-commands-test.fresh");
    }
  });

  it("negative control: nothing this file registered survives it", () => {
    // Guards against `has` assertions above reading leftovers from an earlier case.
    expect(commandRegistry.has("console-commands-test.a")).toBe(false);
    expect(commandRegistry.has("console-commands-test.taken")).toBe(false);
  });
});

describe("window command registry — the published when-clause vocabulary", () => {
  it("names exactly the keys the console's own context supplies", () => {
    // The compiler already checks the derived type; this checks the runtime tuple is the same set.
    expect([...WHEN_CLAUSE_KEYS].sort()).toStrictEqual(Object.keys(NO_CONTEXT).sort());
  });

  it("negative control: a key nobody publishes is not in the vocabulary", () => {
    // Executes the object the `@ts-expect-error` above suppressed.
    expect(Object.keys(CONTEXT_THE_COMPILER_REJECTS)).toContain("sessionActiveish");
    expect(WHEN_CLAUSE_KEYS).not.toContain("sessionActiveish");
    expect(Object.keys(NO_CONTEXT)).not.toContain("sessionActiveish");
  });
});
