// The enumeration has four endings, and a surface has to be able to tell them apart.
//
// Every case drives a REAL growth port — the fixture's over a scenario that scripts
// what the case is about, or the refusing one — rather than a promise shaped like one.
// The hook's whole job is to turn one port call into the facts a browser renders, and
// a stand-in port would agree with whatever the hook did with it.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type GrowthPort } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port.js";
import type { ConsoleScenario, ScenarioReply } from "../bridge/scenario.js";
import type { WireErrorEnvelope } from "../../../../shared/wire-errors.js";
import {
  useWorkflowDefinitionDirectory,
  type WorkflowDefinitionDirectoryState,
} from "./definition-directory.js";

const PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";
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

function DirectoryProbe(props: {
  readonly growth: GrowthPort;
  readonly sessionId: string | undefined;
  readonly onObserve: (state: WorkflowDefinitionDirectoryState) => void;
}): React.JSX.Element {
  props.onObserve(useWorkflowDefinitionDirectory(props.growth, props.sessionId));
  return <></>;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function observeDirectory(
  growth: GrowthPort,
  sessionId: string | undefined,
): WorkflowDefinitionDirectoryState[] {
  const observed: WorkflowDefinitionDirectoryState[] = [];
  render(
    <DirectoryProbe
      growth={growth}
      sessionId={sessionId}
      onObserve={(state) => {
        observed.push(state);
      }}
    />,
  );
  return observed;
}

function lastState(
  observed: readonly WorkflowDefinitionDirectoryState[],
): WorkflowDefinitionDirectoryState {
  const state = observed.at(-1);
  if (state === undefined) {
    throw new Error("the probe never rendered, so there is no state to read");
  }
  return state;
}

describe("useWorkflowDefinitionDirectory — one read, four answers", () => {
  afterEach(() => {
    cleanup();
  });

  it("puts no question at all where no session is in scope", () => {
    // `unasked` and never `reading`: a spinner over an address that names no session
    // would promise an answer that is never coming.
    expect(lastState(observeDirectory(createRefusingGrowthPort(), undefined)).status).toBe(
      "unasked",
    );
  });

  it("starts as a read in flight and settles on what the scenario serves", async () => {
    // A scenario that scripts nothing is served EMPTY rather than refused: an
    // enumeration has an empty form and it is a real answer about this context.
    const growth = createFixtureBridge({ scenario: scenarioAnsweringTheEnumeration([]) }).growth;

    const observed = observeDirectory(growth, PROBE_SESSION_ID);
    // The state after the mount and before the answer. The first observation is the
    // pre-effect `unasked` default, which says nothing about what the hook asked.
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
    expect(observed.map((state) => state.status)).not.toContain("served");
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
