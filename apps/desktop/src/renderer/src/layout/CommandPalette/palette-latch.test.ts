// Running against the latched reading, and both ways it can refuse. `hidden-in-context` is
// reachable when a command is re-registered under a narrower `when` while the palette is open.
// The registry decides eligibility; these cases assert its decision, not a second rule.

import { describe, expect, it } from "vitest";

import { CommandRegistry } from "@renderer/registries/commands/command-registry.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { PALETTE_INVOCATION_REFUSAL_ORIGIN, runLatchedCommand } from "./palette-latch.js";
import type { WhenClauseContext } from "@renderer/registries/commands/when-clause/when-clause.js";

const ON_SESSION: WhenClauseContext = { onSession: true, onSettings: false };
const COMMAND_ID = "test.interruptTheRun";

/** A command offered exactly where the reading below says it is. */
function commandOfferedOnSession(ran: string[]): CommandDefinition {
  return {
    id: COMMAND_ID,
    title: "Interrupt the run",
    group: "Run",
    when: "onSession",
    run: () => {
      ran.push(COMMAND_ID);
    },
  };
}

describe("running a latched command", () => {
  it("runs and refuses nothing where the reading still admits the command", () => {
    // Control for the refusal cases: a dispatch that always refused would satisfy both.
    const ran: string[] = [];
    const registry = new CommandRegistry();
    registry.register(commandOfferedOnSession(ran));

    expect(runLatchedCommand(registry, COMMAND_ID, ON_SESSION)).toBeUndefined();
    expect(ran).toStrictEqual([COMMAND_ID]);
  });

  it("names the command that left the registry, and runs nothing", () => {
    const ran: string[] = [];
    const registry = new CommandRegistry();
    registry.register(commandOfferedOnSession(ran));
    registry.unregister(COMMAND_ID);

    const refusal = runLatchedCommand(registry, COMMAND_ID, ON_SESSION);

    expect(refusal?.code).toBe("unknown-command");
    expect(refusal?.origin).toBe(PALETTE_INVOCATION_REFUSAL_ORIGIN);
    expect(ran).toStrictEqual([]);
  });

  it("names a command the captured reading no longer admits, and runs nothing", () => {
    // Re-registered under a clause the captured reading answers `false`.
    const ran: string[] = [];
    const registry = new CommandRegistry();
    registry.register(commandOfferedOnSession(ran));
    registry.unregister(COMMAND_ID);
    registry.register({ ...commandOfferedOnSession(ran), when: "onSettings" });

    const refusal = runLatchedCommand(registry, COMMAND_ID, ON_SESSION);

    expect(refusal?.code).toBe("hidden-in-context");
    expect(refusal?.origin).toBe(PALETTE_INVOCATION_REFUSAL_ORIGIN);
    expect(ran).toStrictEqual([]);
  });
});
