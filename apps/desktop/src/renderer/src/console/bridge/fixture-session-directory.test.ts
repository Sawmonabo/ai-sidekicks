// Which declared session states put a session in the fixture's directory.
//
// The defect this file exists for: the filter was a free `Set<string>` and had
// drifted in both directions at once. It admitted `paused`, which the contract's
// `SessionState` union has never contained, so a scenario could serve a directory
// row no daemon can send — and the suite that drove it asserted that row, which
// made the impossible payload look deliberate. And it dropped `closed` and
// `purge_requested`, both registered, so a session that really exists rendered as
// an empty directory, which reads exactly like a fresh install with nothing in it.
//
// The rule is now derived from the contract's own closed set, and this file drives
// every member of that set through the real derivation rather than through a list
// retyped here: the states come off `SessionStateSchema`, so a state added to the
// wire arrives in this sweep without anyone remembering to add it.

import type { SessionState } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { ConsoleRefusalError } from "../core/index.js";
import { directorySessionsOf } from "./fixture-session-directory.js";
import type { ConsoleScenario } from "./scenario.js";
import { FIRST_RUN_SCENARIO } from "./scenarios/first-run.js";

/**
 * Every registered session state, as a total record so a member added to the
 * contract lands in the sweep below without anyone remembering to add it.
 *
 * The keys are the sweep's INPUTS; the value carries no rule. What the directory
 * does with each state is what `directorySessionsOf` answers, asserted per state
 * in the named cases further down rather than recomputed from a table here —
 * `SessionStateSchema` is exported as `z.ZodType<SessionState>`, which erases the
 * enum's runtime `options`, so the key set is written out and the compiler holds
 * it total.
 */
const REGISTERED_SESSION_STATE_KEYS: Readonly<Record<SessionState, true>> = {
  provisioning: true,
  active: true,
  archived: true,
  closed: true,
  purge_requested: true,
  purged: true,
};

const REGISTERED_SESSION_STATES = Object.keys(REGISTERED_SESSION_STATE_KEYS) as SessionState[];

/**
 * A scenario whose `session.read` reply declares `state`.
 *
 * Built by rewriting the first-run scenario's own reply rather than by composing a
 * fresh one, so the shape the derivation reads through is the shape a real scenario
 * has — a stand-in reply would be this file's own idea of a scripted read.
 */
function scenarioDeclaring(state: string): ConsoleScenario {
  return {
    ...FIRST_RUN_SCENARIO,
    id: `first-run-declaring-${state}`,
    replies: FIRST_RUN_SCENARIO.replies.map((reply) =>
      reply.call === "session.read"
        ? {
            call: "session.read",
            result: {
              session: {
                id: FIRST_RUN_SCENARIO.sessionId,
                state,
                config: {},
                metadata: {},
                createdAt: FIRST_RUN_SCENARIO.startedAtIso,
                updatedAt: FIRST_RUN_SCENARIO.startedAtIso,
              },
              timelineCursors: { latest: "first-run-cursor-1" },
            },
          }
        : reply,
    ),
  };
}

describe("the directory over every registered session state", () => {
  it.each(REGISTERED_SESSION_STATES.map((state) => [state] as const))(
    "%s: answers either nothing or exactly this session, carrying the state verbatim",
    (state) => {
      // The shape claim, swept over every registered member: whatever the rule
      // decides, the fixture never invents a second row and never relabels the
      // state it read. Which states are listed is asserted case by case below.
      const sessions = directorySessionsOf(scenarioDeclaring(state));

      expect(sessions.length).toBeLessThanOrEqual(1);
      for (const session of sessions) {
        expect(session).toStrictEqual({ sessionId: FIRST_RUN_SCENARIO.sessionId, state });
      }
    },
  );

  it("lists an active session and an archived one", () => {
    for (const state of ["active", "archived"] as const) {
      expect(directorySessionsOf(scenarioDeclaring(state))).toStrictEqual([
        { sessionId: FIRST_RUN_SCENARIO.sessionId, state },
      ]);
    }
  });

  it("lists a closed session, which the old allow-list dropped", () => {
    // Called out on its own because this is the row a person loses: a closed
    // session still exists on the node, and an empty directory says it does not.
    expect(directorySessionsOf(scenarioDeclaring("closed"))).toStrictEqual([
      { sessionId: FIRST_RUN_SCENARIO.sessionId, state: "closed" },
    ]);
  });

  it("lists a purge-requested session, so a pending erasure stays visible", () => {
    expect(directorySessionsOf(scenarioDeclaring("purge_requested"))).toStrictEqual([
      { sessionId: FIRST_RUN_SCENARIO.sessionId, state: "purge_requested" },
    ]);
  });

  it("hides the two ends of the lifecycle, which are not a session anyone can open", () => {
    expect(directorySessionsOf(scenarioDeclaring("provisioning"))).toStrictEqual([]);
    expect(directorySessionsOf(scenarioDeclaring("purged"))).toStrictEqual([]);
  });

  it("negative control: the rule is not 'list everything' and not 'list nothing'", () => {
    // Without this the sweep above would hold over a derivation that answered the
    // same way for every state, since the expectation is computed from the same
    // membership test the reader would then be tempted to call the rule.
    const answers = REGISTERED_SESSION_STATES.map(
      (state) => directorySessionsOf(scenarioDeclaring(state)).length,
    );

    expect(answers).toContain(1);
    expect(answers).toContain(0);
  });
});

describe("the directory on a state the contract does not register", () => {
  it("refuses by name rather than serving a row no wire can send", () => {
    // `paused` is the exact value the old filter admitted. A scenario is in-tree
    // source, so this is an authoring defect and it fails loudly; answering with an
    // empty directory would hide it behind the answer a first run legitimately gives.
    expect(() => directorySessionsOf(scenarioDeclaring("paused"))).toThrow(ConsoleRefusalError);
    expect(() => directorySessionsOf(scenarioDeclaring("paused"))).toThrow(
      /session-state-unregistered/u,
    );
  });

  it("answers an empty directory when a scenario declares no state at all", () => {
    // The control that separates "unregistered" from "unstated": a scenario that
    // scripts no session read has not said the session exists, which is silence
    // rather than a defect, and silence is an empty directory.
    const withoutSessionRead: ConsoleScenario = {
      ...FIRST_RUN_SCENARIO,
      id: "first-run-without-session-read",
      replies: FIRST_RUN_SCENARIO.replies.filter((reply) => reply.call !== "session.read"),
    };

    expect(directorySessionsOf(withoutSessionRead)).toStrictEqual([]);
  });
});
