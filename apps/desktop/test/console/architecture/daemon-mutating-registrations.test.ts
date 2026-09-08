// The console's mutating-method tuple, held to the daemon's own registrations.
//
// `store/shell-state.ts` names the methods a supervisor outage closes, and its
// authority is a registration's `mutating` flag. That agreement was prose until this
// gate: the tuple was read off the daemon's handlers once, by hand, and nothing
// reported it the next time one landed — which is how `providerAccount.probe` came to
// be called a mutating verb in the daemon-call registry and left out of the set that
// blocks it.
//
// ONE DIRECTION, AND THE READER BESIDE THIS SAYS WHY. The daemon has shipped handlers
// for a fraction of what the console calls, so absence there is not read-only and an
// equality check would fail on the growth slate. What is asserted is the bound a
// census supports: nothing shipped mutating is missing from the tuple, and nothing in
// the tuple is shipped read-only.

import { describe, expect, it } from "vitest";

import { MUTATING_DAEMON_METHODS } from "../../../src/renderer/src/console/store/shell/shell-mutation-block.js";
import {
  contradictedRegistrations,
  daemonIpcRegistrations,
  daemonMethodRegistrationsIn,
  unclassifiedMutatingRegistrations,
} from "./daemon-mutating-registrations.js";

/** The console's claim, as the data the two checkers take. */
const CLASSIFIED_MUTATING: readonly string[] = [...MUTATING_DAEMON_METHODS];

/**
 * The floor this reading is asserted against.
 *
 * A gate whose reader has gone blind reports zero offenders and reads exactly like a
 * clean tree. Six handlers carry `mutating: true` today — the two session verbs and
 * four driver verbs — so a reading below that is the instrument failing rather than
 * the claim holding.
 */
const SHIPPED_MUTATING_FLOOR = 6;

describe("the daemon's mutating registrations, against the console's tuple", () => {
  it("names every method the daemon ships as mutating", () => {
    const registrations = daemonIpcRegistrations();
    expect(unclassifiedMutatingRegistrations(registrations, CLASSIFIED_MUTATING)).toStrictEqual([]);
  });

  it("contradicts nothing the daemon ships read-only", () => {
    const registrations = daemonIpcRegistrations();
    expect(contradictedRegistrations(registrations, CLASSIFIED_MUTATING)).toStrictEqual([]);
  });

  it("read a daemon surface that actually registers — the vacuity floor", () => {
    const registrations = daemonIpcRegistrations();
    const mutating = registrations.filter((registration) => registration.mutating);
    expect(registrations.length).toBeGreaterThan(mutating.length);
    expect(mutating.length).toBeGreaterThanOrEqual(SHIPPED_MUTATING_FLOOR);
  });
});

describe("the reader, driven against planted registrations", () => {
  /** A handler module registering one method, with the options a case names. */
  function plantedHandler(method: string, options: string): string {
    return [
      'import { SomeRequestSchema, SomeResponseSchema } from "@ai-sidekicks/contracts";',
      "",
      "export function registerPlanted(registry: MethodRegistry): void {",
      `  registry.register(${JSON.stringify(method)}, SomeRequestSchema, SomeResponseSchema, handler${options});`,
      "}",
    ].join("\n");
  }

  it("reports a mutating registration the console does not classify", () => {
    // The negative control for the first case. Without it a checker that answered the
    // empty array to everything would read as a tree in agreement with itself.
    const registrations = daemonMethodRegistrationsIn(
      "planted-handler.ts",
      plantedHandler("session.rename", ", { mutating: true }"),
    );

    expect(unclassifiedMutatingRegistrations(registrations, CLASSIFIED_MUTATING)).toStrictEqual([
      "planted-handler.ts: session.rename",
    ]);
  });

  it("reports a tuple member the daemon ships read-only", () => {
    const registrations = daemonMethodRegistrationsIn(
      "planted-handler.ts",
      plantedHandler("session.create", ", { mutating: false }"),
    );

    expect(contradictedRegistrations(registrations, CLASSIFIED_MUTATING)).toStrictEqual([
      "planted-handler.ts: session.create",
    ]);
  });

  it("takes an absent options object as the registry's own default", () => {
    // Not a guess: `RegisterOptions.mutating` defaults to `false`, so a registration
    // with no options is read-only — and a reader that defaulted the other way would
    // report every subscription in the daemon as an unclassified write.
    const registrations = daemonMethodRegistrationsIn(
      "planted-handler.ts",
      plantedHandler("session.read", ""),
    );

    expect(registrations).toStrictEqual([
      { method: "session.read", mutating: false, displayPath: "planted-handler.ts" },
    ]);
  });

  it("does not read the word out of a comment — the control", () => {
    // The instrument is the parser and not a pattern, and this is what that buys: the
    // module beside this one carries `mutating: true` in its own prose four times.
    const registrations = daemonMethodRegistrationsIn(
      "planted-handler.ts",
      ["// A handler registered `session.rename` with { mutating: true } once.", "export {};"].join(
        "\n",
      ),
    );

    expect(registrations).toStrictEqual([]);
  });
});
