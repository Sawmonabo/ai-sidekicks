// Running against the latched reading, and both ways it can refuse.
//
// The overlay's suite drives the arm a person actually meets — a command the registry
// no longer holds — through the rendered rows. This file is the other arm and the
// vocabulary itself: `hidden-in-context` is reachable in production (a family that
// unregisters and re-registers a command with a narrower `when` while the palette is
// open leaves a captured row over a command the captured reading no longer admits), and
// an arm that ships with no case at all is an arm whose sentence nobody has read.
//
// THE REFUSAL IS NOT A SECOND ELIGIBILITY RULE, and the first case is what says so: the
// registry decides, against the reading it was handed, and these cases assert what it
// decided rather than re-deriving it.

import { describe, expect, it } from "vitest";

import { CommandRegistry } from "./command-registry.js";
import type { ConsoleCommand } from "./contributions.js";
import { PALETTE_INVOCATION_REFUSAL_ORIGIN, runLatchedCommand } from "./palette-latch.js";
import type { WhenClauseContext } from "./when-clause.js";

const ON_WORKSPACE: WhenClauseContext = { onWorkspace: true, onSettings: false };
const COMMAND_ID = "test.interruptTheRun";

/** A command offered exactly where the reading below says it is. */
function commandOfferedOnWorkspace(ran: string[]): ConsoleCommand {
  return {
    id: COMMAND_ID,
    title: "Interrupt the run",
    group: "Run",
    when: "onWorkspace",
    run: () => {
      ran.push(COMMAND_ID);
    },
  };
}

describe("running a latched command", () => {
  it("runs and refuses nothing where the reading still admits the command", () => {
    // The control every refusal case below rests on: a dispatch that refused
    // unconditionally would satisfy both of them.
    const ran: string[] = [];
    const registry = new CommandRegistry();
    registry.register(commandOfferedOnWorkspace(ran));

    expect(runLatchedCommand(registry, COMMAND_ID, ON_WORKSPACE)).toBeUndefined();
    expect(ran).toStrictEqual([COMMAND_ID]);
  });

  it("names the command that left the registry, and runs nothing", () => {
    const ran: string[] = [];
    const registry = new CommandRegistry();
    registry.register(commandOfferedOnWorkspace(ran));
    registry.unregister(COMMAND_ID);

    const refusal = runLatchedCommand(registry, COMMAND_ID, ON_WORKSPACE);

    expect(refusal?.code).toBe("unknown-command");
    expect(refusal?.origin).toBe(PALETTE_INVOCATION_REFUSAL_ORIGIN);
    expect(ran).toStrictEqual([]);
  });

  it("names a command the captured reading no longer admits, and runs nothing", () => {
    // Re-registered under a clause the captured reading answers `false`, which is what a
    // family does when what its commands close over changes while the palette is open.
    const ran: string[] = [];
    const registry = new CommandRegistry();
    registry.register(commandOfferedOnWorkspace(ran));
    registry.unregister(COMMAND_ID);
    registry.register({ ...commandOfferedOnWorkspace(ran), when: "onSettings" });

    const refusal = runLatchedCommand(registry, COMMAND_ID, ON_WORKSPACE);

    expect(refusal?.code).toBe("hidden-in-context");
    expect(refusal?.origin).toBe(PALETTE_INVOCATION_REFUSAL_ORIGIN);
    expect(ran).toStrictEqual([]);
  });
});
