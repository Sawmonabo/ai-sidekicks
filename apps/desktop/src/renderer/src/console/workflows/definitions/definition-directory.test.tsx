// The enumeration has four endings, and a surface has to be able to tell them apart.
//
// These cases drive a REAL growth port — the fixture's over a scenario that scripts
// what the case is about, or the refusing one — rather than a promise shaped like
// one. The pages beyond the first are the other suite, `definition-directory.paging`:
// they cannot use a scenario at all, because the engine matches a scripted reply on
// the call name alone and one scenario can therefore serve exactly one page.
//
// The mount both suites share — the probe, the readings taken off it, and the port
// that answers per cursor — is `definition-directory.test-support.tsx`.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, createRefusingGrowthPort } from "../../bridge/index.js";
import type { ConsoleScenario, ScenarioReply } from "../../bridge/scenario.js";
import type { WireErrorEnvelope } from "../../../../../shared/wire-errors.js";
import { PROBE_SESSION_ID } from "../WorkflowsBrowser.test-support.js";
import type {
  WorkflowDefinitionDirectory,
  WorkflowDefinitionDirectoryState,
} from "./definition-directory.js";
import {
  definitionIds,
  lastState,
  observeDirectory,
  rescopableDirectory,
  settle,
  twoPagePort,
} from "./definition-directory.test-support.js";

/** A second session, so a scope change is a change of subject and not of nothing. */
const SECOND_PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3402";
const PROBE_PARTICIPANT_ID = "019b7a12-0280-79a4-8110-cca0117a0401";

/** The refusal the scenario below scripts, in the envelope a daemon sends. */
const SCRIPTED_DAEMON_REFUSAL: WireErrorEnvelope = {
  code: "workflow.session_not_found",
  message: "No session with that id is open on this node.",
};

/**
 * A scenario answering the enumeration one way, and playing no beats.
 *
 * No beats: this hook never reads the event stream, and beats would have to be held to
 * the wire-truth layer for facts no case here asserts.
 */
function scenarioAnsweringTheEnumeration(replies: readonly ScenarioReply[]): ConsoleScenario {
  return {
    id: "definition-directory-probe",
    label: "Definition directory probe",
    purpose: "Answers the definition enumeration one way, so one settlement is observable.",
    sessionId: PROBE_SESSION_ID,
    participantIdsInJoinOrder: [PROBE_PARTICIPANT_ID],
    startedAtIso: "2026-01-01T12:00:00.000Z",
    beats: [],
    replies,
  };
}

function firstState(
  observed: readonly WorkflowDefinitionDirectory[],
): WorkflowDefinitionDirectoryState {
  const directory = observed[0];
  if (directory === undefined) {
    throw new Error("the probe never rendered, so there is nothing to read");
  }
  return directory.state;
}

describe("useWorkflowDefinitionDirectory — one read, four answers", () => {
  afterEach(() => {
    cleanup();
  });

  it("puts no question at all where no session is in scope", () => {
    // `unasked` and never `reading`: a spinner over an address that names no session
    // would promise an answer that is never coming. Asserted on the FIRST render as
    // well as the last, so the arm that must stay `unasked` is held to the same
    // moment as the arm below that must not be.
    const observed = observeDirectory(createRefusingGrowthPort(), undefined);
    expect(firstState(observed).status).toBe("unasked");
    expect(lastState(observed).status).toBe("unasked");
  });

  it("is already reading on the first render a session is in scope for", () => {
    // The state was initialised `unasked` and only became `reading` in the effect,
    // which runs after the commit — so every scoped load had one committed render
    // claiming nobody had asked, and the browser draws that as three served-looking
    // empty groups ("No session definitions") before the request has answered.
    const growth = createFixtureBridge({ scenario: scenarioAnsweringTheEnumeration([]) }).growth;
    expect(firstState(observeDirectory(growth, PROBE_SESSION_ID)).status).toBe("reading");
  });

  it("shows the previous session's definitions nowhere once the scope moves", async () => {
    // Before the stamp, the first session's rows stayed renderable under the second
    // session's name until the effect got round to resetting them, and nothing on
    // screen said which session they had been read for.
    const probe = rescopableDirectory(twoPagePort(), PROBE_SESSION_ID);
    await settle();
    expect(definitionIds(lastState(probe.observed))).toEqual(["first", "second"]);

    act(() => {
      probe.rescope(SECOND_PROBE_SESSION_ID);
    });

    expect(lastState(probe.observed).status).toBe("reading");
  });

  it("starts as a read in flight and settles on what the scenario serves", async () => {
    // A scenario that scripts nothing is served EMPTY rather than refused: an
    // enumeration has an empty form and it is a real answer about this context.
    const growth = createFixtureBridge({ scenario: scenarioAnsweringTheEnumeration([]) }).growth;

    const observed = observeDirectory(growth, PROBE_SESSION_ID);
    // The state after the mount and before the answer. Every render of it, first
    // included, because the read is held against the session it is about.
    expect(lastState(observed).status).toBe("reading");

    await settle();
    // The control for the refusal cases below: a hook that refused every read would
    // satisfy them and would replace every served answer with a refusal too.
    expect(lastState(observed).status).toBe("served");
  });

  it("settles a scripted daemon refusal as unavailable, carrying the wire's own code", async () => {
    // The negative control is the assertion itself: over the `.then`-only hook this
    // read replaced, the rejection was unhandled and the last state observed here was
    // `reading` — permanently, for the life of the window.
    const observed = observeDirectory(
      createFixtureBridge({
        scenario: scenarioAnsweringTheEnumeration([
          { call: "workflow.definitionList", refusal: SCRIPTED_DAEMON_REFUSAL },
        ]),
      }).growth,
      PROBE_SESSION_ID,
    );

    await settle();
    const settled = lastState(observed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      expect(settled.refusal.code).toBe(SCRIPTED_DAEMON_REFUSAL.code);
      expect(settled.refusal.detail).toBe(SCRIPTED_DAEMON_REFUSAL.message);
    }
    expect(observed.map((directory) => directory.state.status)).not.toContain("served");
  });

  it("carries the port's own refusal when no wire is registered", async () => {
    const observed = observeDirectory(createRefusingGrowthPort(), PROBE_SESSION_ID);

    await settle();
    const settled = lastState(observed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      // The refusal names who owes the wire. A boolean here would leave the surface to
      // invent the sentence, which is how two answers to one question start.
      expect(settled.refusal.code).toBe("wire-unregistered");
      expect(settled.refusal.detail).toContain("Not checked");
    }
  });
});
