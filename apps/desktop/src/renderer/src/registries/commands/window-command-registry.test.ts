// The window's command registry door and the `when` vocabulary it publishes.
//
// The vocabulary is checked from both sides: the tuple a feature reads at runtime and
// the context type the compiler holds must be one set.

import { describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "@renderer/lib/keyed-registry.js";
import {
  WHEN_CLAUSE_KEYS,
  commandRegistry,
  registerCommands,
  type WindowWhenClauseContext,
} from "./window-command-registry.js";

/** Every key the console publishes, all false — the shape, not a situation. */
const NO_CONTEXT: WindowWhenClauseContext = {
  sessionActive: false,
  onSessions: false,
  onWorkspace: false,
  onWorkflows: false,
  onSettings: false,
};

/**
 * The compile-time control for the vocabulary.
 *
 * A context is typed to exactly the published keys, so an invented one is an
 * excess property the compiler refuses at the author's keyboard rather than a
 * clause that quietly evaluates false and hides the command. If the type were ever
 * widened to `Record<string, boolean>`, the suppressed error would stop occurring
 * and this directive would itself become the error.
 */
const CONTEXT_THE_COMPILER_REJECTS: WindowWhenClauseContext = {
  ...NO_CONTEXT,
  // @ts-expect-error — `sessionActiveish` is not a key the console publishes.
  sessionActiveish: false,
};

describe("window command registry — the door commands are registered through", () => {
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
    // Atomic is the whole reason the plural door exists. Half an owner's commands
    // is a state no caller can reason about, and none of them unwinds it.
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
    // Without this every case above would pass against a door that registered
    // into a registry nobody reads, and the `has` assertions would be reading
    // leftovers from the case before.
    expect(commandRegistry.has("console-commands-test.a")).toBe(false);
    expect(commandRegistry.has("console-commands-test.taken")).toBe(false);
  });
});

describe("window command registry — the published when-clause vocabulary", () => {
  it("names exactly the keys the console's own context supplies", () => {
    // The tuple is the declaration and `WindowWhenClauseContext` is derived from
    // it, so the compiler already refuses a context that is missing a key or
    // invents one. This holds the other direction at runtime: that the tuple a
    // family READS is the same set, rather than a stale copy of it.
    expect([...WHEN_CLAUSE_KEYS].sort()).toStrictEqual(Object.keys(NO_CONTEXT).sort());
  });

  it("negative control: a key nobody publishes is not in the vocabulary", () => {
    // Reads the object the `@ts-expect-error` above suppressed, so the directive
    // is a claim this file executes rather than a comment nobody runs.
    expect(Object.keys(CONTEXT_THE_COMPILER_REJECTS)).toContain("sessionActiveish");
    expect(WHEN_CLAUSE_KEYS).not.toContain("sessionActiveish");
    expect(Object.keys(NO_CONTEXT)).not.toContain("sessionActiveish");
  });
});
