// What every run-pane suite needs before it can render a pane.
//
// The pane's cases split by concern — the arms, the graph's park treatment, the
// address guard, the run-detail mount, the multi-form routing — and all five mount
// the pane the same way, against one of the same two bridges, at one of the same two
// addresses. One home for that, so a change to how the pane is stood up is one edit
// rather than five that drift apart while every suite stays green.
//
// TWO BRIDGES, AND THE PAIR IS THE POINT. The workflows scenario scripts the run
// read, so the pane mounted against it shows what a daemon would have said; the
// flagship scenario scripts no workflow reply at all, so the same pane against it
// shows the port's typed refusal. Without the second, a green run would not
// distinguish a pane that reads from one that renders the served arm unconditionally.
//
// AND THE BRANCHING RUN IS HERE NOW, because it has two readers. The routing cases
// and the phase-address cases both need a run that parks two phases on a person: a run
// with one wait cannot tell "opened the phase it was asked for" apart from "opened the
// only one there was". What stays beside its one reader is still what one suite reads —
// the park-attention projection the graph is measured against, and the run-detail spy.
//
// What is deliberately NOT here is the `vi.mock` line itself. Vitest hoists that per
// FILE, so it stays in each suite that spies the form slot and only the READING of the
// spy lives here.

import { render } from "@testing-library/react";
import { vi } from "vitest";

import {
  createFixtureBridge,
  type ConsoleBridge,
  type WorkflowPhaseState,
  type WorkflowRunSnapshot,
} from "../../../bridge/index.js";
import type { ConsoleScenario } from "../../../bridge/scenario-runtime/scenario.js";
import { FLAGSHIP_SCENARIO } from "../../../bridge/scenarios/flagship.js";
import { WORKFLOWS_PARKED_RUN } from "../../../bridge/scenarios/workflow-fixture-runs.js";
import { WORKFLOWS_SCENARIO } from "../../../bridge/scenarios/workflows.js";
import type { ConsoleRoute } from "../../../routing/index.js";
import type { PaneContextOf } from "../../../seats/index.js";
import { FrameStore, SessionStore, type ConsoleEntityRef } from "../../../store/index.js";
import { HumanFormSlot } from "./slots/HumanFormSlot.js";
import { WorkflowRunPane } from "./WorkflowRunPane.js";

/**
 * What a cast pane context may be addressed at.
 *
 * Any console entity or none — the set the pane's own two guards project, rather than
 * `ConsolePaneAddress`'s own arm for this kind, because the cases below drive exactly
 * the addresses the arm makes unconstructible and the guards still refuse.
 */
export type AddressedEntity = ConsoleEntityRef | undefined;

/** The address the run view is meant to open. */
export const PARKED: ConsoleEntityRef = {
  kind: "workflow-run",
  id: WORKFLOWS_PARKED_RUN.workflowRunId,
};

// An address this pane must not open. `CONSOLE_ENTITY_KINDS` registers
// `workflow-definition` beside `workflow-run`, and the deck hands a pane whichever
// one its layout carried — so the run view is reachable at a definition, and the id
// under it is a definition id.
export const MISADDRESSED: ConsoleEntityRef = {
  kind: "workflow-definition",
  id: "definition-01",
};

/**
 * The fields the pane and its chrome read, and nothing else.
 *
 * Cast rather than constructed, the idiom `frame/legacy-surfaces.test.ts`
 * established: a real pane context carries three stores, one of which opens a
 * database on construction, and building all of that to hand four fields to a
 * component that reads four fields would make the setup the subject. The bridge is
 * real, because the pane now asks it something.
 *
 * THE CAST IS ALSO WHAT LETS THE MISADDRESSED CASES EXIST. `PaneContextOf` declares
 * this arm's entity as a run reference, and the addresses these suites drive are
 * exactly the ones that arm makes unconstructible and the pane's guards still refuse —
 * which is the situation a parsed layout row actually produces.
 */
export function paneContext(
  entity: AddressedEntity,
  bridge: ConsoleBridge,
  // The exact store to mount over, for a case whose subject is what the SESSION says.
  //
  // Every other case here only needs the pane to have a store at all, and a fresh one
  // per call is what those want. A case that puts a frame on the timeline has to hold
  // the same object the pane is watching, and naming it is how that is said — the
  // shape `repos/artifact-pane/artifact-pane-mount.test-support.ts` uses for the same
  // split.
  sessionStore: SessionStore = initialisedSessionStore(),
  // The route the window has committed, for a case whose subject is what a LINK said.
  //
  // Omitted and `undefined` mean the same thing here and that is deliberate: the frame
  // store's own default route names no workflow phase, which is the state every other
  // case in these suites is asserting against, so there is no reading of "unset" that
  // differs from "a route carrying no phase".
  committedRoute?: ConsoleRoute,
): PaneContextOf<"workflow-run"> {
  return {
    kind: "workflow-run",
    entity,
    bridge,
    // A REAL frame store, for the session store's reason one line down: the pane reads
    // the committed route off it to seed which parked phase's form opens, so a context
    // without one throws at mount rather than rendering a pane with no link focus.
    frameStore: new FrameStore(
      committedRoute === undefined ? {} : { initialRoute: committedRoute },
    ),
    // A REAL store rather than the `{ sessionId }` stub this used to cast, because
    // the pane's live-round reading subscribes to the session's own transitions —
    // `run-live-rounds.ts`, which is how a run moved by the engine or by another
    // window reaches this pane at all. A stub answers `sessionId` and nothing else,
    // so that subscription would throw at mount in every suite here. Initialised for
    // the same reason the trigger set requires it: a base state is not a frame.
    sessionStore,
    // No actor attributes this pane in a suite, which is the chrome's neutral arm.
    focusHue: undefined,
  } as unknown as PaneContextOf<"workflow-run">;
}

/**
 * The pane's session, established, so a frame applied to it is a transition.
 *
 * Its cursor is the beat just before the workflows scenario's first, so a case that
 * lets the frozen clock deliver that scenario's own beats into this store gets six
 * transitions rather than a gap the store would degrade over.
 */
export function initialisedSessionStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: WORKFLOWS_PARKED_RUN.sessionId });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return sessionStore;
}

/** A bridge that answers the workflow reads. */
export function answeringBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
}

/** And one that answers nothing, so the pane renders the port's refusal instead. */
export function silentBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
}

export function renderPane(context: PaneContextOf<"workflow-run">): HTMLElement {
  const { container } = render(<WorkflowRunPane context={context} />);
  // The pane chrome's own `<section>` — every assertion in these suites is scoped to
  // the whole pane, head included, because the head is where the address trail and the
  // host controls are.
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the pane rendered no section");
  }
  return section;
}

/**
 * How long a wait for the graph's own DOM is given.
 *
 * The phase graph is a lazily-loaded chunk — `phase-graph/index.ts` is reached by an
 * `import()` and by nothing else — so every node, every `data-park` attribute, and
 * the caption appear only once that import has resolved. Testing Library's `waitFor`
 * default is one second, and the chunk's own load is measured longer than that under
 * aggregate tier load (1898 ms for the read-in-flight case in the same run that
 * failed a one-second wait here), so a suite asserting post-chunk DOM under the
 * default is bounding a LATENCY it never meant to bound and reads as a DOM failure
 * when it trips.
 *
 * The number bounds the chunk and weakens no claim: every assertion inside these
 * waits still fails on the wrong DOM, only later. It stays under the tier's own
 * five-second per-test budget (`console-unit` sets no `testTimeout`, so Vitest's
 * default applies) so an exhausted wait reports the DOM it actually found rather
 * than being cut off by the generic test kill first.
 */
export const GRAPH_CHUNK_WAIT = { timeout: 4000 } as const;

/**
 * The fixture's own human wait, which is the shape every derived phase keeps.
 *
 * Read off the scenario rather than written out: `phaseRunId` and `formRevision` are
 * exactly what makes a wait addressable, and a hand-written phase would keep passing
 * if the fixture stopped carrying them.
 */
export function fixtureHumanWait(): WorkflowPhaseState {
  const phase = WORKFLOWS_PARKED_RUN.phaseStates.find(
    (candidate) => candidate.parkReason === "waiting-human",
  );
  if (phase === undefined) {
    throw new Error("the workflows fixture parks no phase on a person");
  }
  return phase;
}

/** The second branch's phase-run key, in the wire's own shape and nobody else's. */
export const SECOND_WAIT_PHASE_RUN_ID = "019b7a10-0280-7aa1-8100-701a11150009";

/**
 * The fixture's parked run with a SECOND phase parked on a person beside the first.
 *
 * HOISTED ON ITS SECOND READER, which is `apps/desktop/AGENTS.md`'s rule: the routing
 * cases and the phase-address cases both need a run that branches, because a run with
 * one wait cannot distinguish "opened the phase it was asked for" from "opened the only
 * one there was". A second copy would agree with this one until one of them grew a
 * third branch.
 */
export function runWithTwoHumanWaits(): WorkflowRunSnapshot {
  const first = fixtureHumanWait();
  return {
    ...WORKFLOWS_PARKED_RUN,
    phaseStates: WORKFLOWS_PARKED_RUN.phaseStates.flatMap((phase) =>
      phase.phaseId === first.phaseId
        ? [
            phase,
            {
              ...first,
              phaseId: `${first.phaseId}-second-branch`,
              phaseRunId: SECOND_WAIT_PHASE_RUN_ID,
            },
          ]
        : [phase],
    ),
  };
}

/** Every phase this snapshot parks on a person, in the order the pane resolves them. */
export function humanWaitsOf(run: WorkflowRunSnapshot): readonly WorkflowPhaseState[] {
  return run.phaseStates.filter((phase) => phase.parkReason === "waiting-human");
}

/**
 * A scenario answering the run read with one snapshot, driving the REAL fixture port.
 *
 * The idiom `run-snapshot.test.tsx` established. Scripting the reply rather than
 * replacing the port keeps the pane's read on the same path every other case exercises,
 * so what these cases observe is the pane and not a stand-in.
 */
export function scenarioServingRun(run: WorkflowRunSnapshot, id: string): ConsoleScenario {
  return { ...WORKFLOWS_SCENARIO, id, replies: [{ call: "workflow.runRead", result: run }] };
}

/**
 * The phase whose form the pane actually mounted, on the latest render it made.
 *
 * Reads the spy the CALLING suite installed — `vi.mock` is hoisted per file, so the
 * `vi.mock(import("./slots/HumanFormSlot.js"), { spy: true })` line stays beside the
 * cases and only the reading of it lives here. A suite without that line reads an
 * unmocked component and gets `undefined`, which is a missing spy rather than a
 * mounted form, so every caller declares it.
 */
export function mountedFormPhaseId(): string | undefined {
  return vi.mocked(HumanFormSlot).mock.calls.at(-1)?.[0].phase?.phaseId;
}
