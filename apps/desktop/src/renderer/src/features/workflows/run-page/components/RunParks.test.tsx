// One parked phase, drawn by the pane's card and by the run list's row, from one
// projection.
//
// THE CLAIM IS AN AGREEMENT BETWEEN TWO SURFACES, so the suite renders both. The park
// discriminator, the schedule classification, and the phase's name were derived three
// times — once in `run-list-projection.ts`, once here, and once in the phase graph —
// and two of the three disagreed about the name: the projection read the row's own
// member and this pane substituted a module constant that was permanently `undefined`.
// One run, one park, and a phase the list named while the cards beside it drew it
// nameless. A suite that rendered only one of the two could not see that.

// The run pane's park cards, and the surfaces that draw the same parks.
//
// A parked phase is drawn by the pane's card, by the run list's row and by the phase
// graph's node from one projection, so the cases that claim agreement render both
// surfaces: a suite that rendered only one could not see them disagree. The route each
// card offers to its own form is the card's line, decided from members the park
// projection does not carry, so those cases drive `RunParks` with a stub selection.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";

import type {
  WorkflowPhaseState,
  WorkflowRunSnapshot,
} from "@renderer/services/wire-shapes/workflow-projection.js";
import { RunListItem } from "../../runs/components/RunListItem.js";
import { RunListProjection } from "../../runs/run-list-projection.js";
import {
  PARKED_RUN,
  PHASE_BUILD,
  PHASE_DRAFT,
  PHASE_PUBLISH,
  PHASE_SIGN_OFF,
} from "../../workflows-probe.test-support.js";
import { UNADDRESSABLE_HUMAN_WAIT_DETAIL, humanFormPhaseFor } from "../human-form-phase.js";
import type { HumanFormSelection } from "../hooks/useHumanFormSelection.js";
import { runGraphLoader } from "../run-graph/run-graph-loader.js";
import { RunParks } from "./RunParks.js";
import { RunGraphSection } from "./RunGraphSection.js";
import {
  SECOND_WAIT_PHASE_ID,
  SECOND_WAIT_PHASE_RUN_ID,
} from "../default-human-form-body.test-support.js";

/** A selection that has nothing open, for the cases whose subject is not the form route. */
const NO_FORM_OPEN: HumanFormSelection = {
  openForm: undefined,
  isOpen: () => false,
  openFormFor: () => undefined,
};

/**
 * One phase, parked on a person, carrying an authored name.
 *
 * Bound to a variable rather than written inline at the snapshot: `WorkflowPhaseState`
 * declares no `phaseName`, so a fresh literal in the `phaseStates` position would be
 * refused for the excess property. Through a binding the shape is merely wider than the
 * wire's, which is the shape the two surfaces have to agree on when a phase carries a
 * name.
 */
const NAMED_PARKED_PHASE = {
  phaseId: "phase-review",
  phaseName: "Review",
  state: "running",
  gateState: "open",
  parkReason: "waiting-human",
  parkCause: "Waiting for sign-off.",
} as const;

/** The same phase with its name taken away, and nothing else changed. */
const UNNAMED_PARKED_PHASE = {
  phaseId: "phase-review",
  state: "running",
  gateState: "open",
  parkReason: "waiting-human",
  parkCause: "Waiting for sign-off.",
} as const;

function runWith(phase: WorkflowRunSnapshot["phaseStates"][number]): WorkflowRunSnapshot {
  return {
    workflowRunId: "run-1",
    sessionId: "session-1",
    workflowVersionId: "version-1",
    state: "suspended",
    startedAt: "2026-09-01T10:00:00.000Z",
    phaseStates: [phase],
  };
}

/** What the pane's stack of cards calls the parked phase, or nothing. */
function paneParkPhaseName(run: WorkflowRunSnapshot): string | undefined {
  const { container } = render(<RunParks run={run} humanForms={NO_FORM_OPEN} />);
  return container.querySelector(".meridian-park__phase-name")?.textContent ?? undefined;
}

/** And what the run list's own row calls it, through the projection that feeds it. */
function listParkPhaseName(run: WorkflowRunSnapshot): string | undefined {
  const row = new RunListProjection([run]).rows[0];
  if (row === undefined) {
    throw new Error("the projection produced no row");
  }
  const { container } = render(<RunListItem row={row} onOpenRun={undefined} />);
  return container.querySelector(".meridian-park__phase-name")?.textContent ?? undefined;
}

describe("the phase a park is about", () => {
  it("is named the same by the pane's card and by the run list's row", () => {
    const run = runWith(NAMED_PARKED_PHASE);
    expect(paneParkPhaseName(run)).toBe("Review");
    expect(listParkPhaseName(run)).toBe(paneParkPhaseName(run));
  });

  it("negative control: neither surface invents a name where the read carries none", () => {
    // Without this the case above would be satisfied by two surfaces that both printed
    // the identifier in the name's place, which is the invention this family renders
    // the absence of rather than papering over.
    const run = runWith(UNNAMED_PARKED_PHASE);
    expect(paneParkPhaseName(run)).toBeUndefined();
    expect(listParkPhaseName(run)).toBeUndefined();
  });

  it("negative control: both surfaces still identify the phase by its wire id", () => {
    // And without THIS, the case above would be satisfied by a card that had stopped
    // saying which phase it is about at all — which is what makes a fan-out's cards
    // indistinguishable.
    const run = runWith(UNNAMED_PARKED_PHASE);
    const { container } = render(<RunParks run={run} humanForms={NO_FORM_OPEN} />);
    expect(container.querySelector(".meridian-park__phase")?.textContent).toContain("phase-review");
  });
});

describe("a run with nothing parked", () => {
  it("says so rather than rendering an empty region", () => {
    const run = runWith({ phaseId: "phase-draft", state: "running", gateState: "open" });
    const { container } = render(<RunParks run={run} humanForms={NO_FORM_OPEN} />);
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(container.querySelectorAll(".meridian-park")).toHaveLength(0);
  });
});

/** The probe run's sign-off phase: parked on a person, and carrying the handle to answer it. */
function signOffPhase(): WorkflowPhaseState {
  const phase = PARKED_RUN.phaseStates.find((candidate) => candidate.phaseId === PHASE_SIGN_OFF);
  if (phase === undefined) {
    throw new Error("the probe run has no sign-off phase");
  }
  return phase;
}

/** The probe run with a second phase parked on a person, as a branching run parks two. */
function runWithTwoHumanWaits(): WorkflowRunSnapshot {
  return {
    ...PARKED_RUN,
    phaseStates: [
      ...PARKED_RUN.phaseStates,
      { ...signOffPhase(), phaseId: SECOND_WAIT_PHASE_ID, phaseRunId: SECOND_WAIT_PHASE_RUN_ID },
    ],
  };
}

/** The probe run with its only human wait reported without the handle its form is answered by. */
function runWithAnUnaddressableWait(): WorkflowRunSnapshot {
  const { phaseRunId: _phaseRunId, formRevision: _formRevision, ...unaddressable } = signOffPhase();
  return {
    ...PARKED_RUN,
    phaseStates: PARKED_RUN.phaseStates.map((phase) =>
      phase.phaseId === PHASE_SIGN_OFF ? unaddressable : phase,
    ),
  };
}

/**
 * A selection over `run` with `openPhaseId` as the open form, and the call a card's route
 * control makes to ask for its own.
 */
function selectionOver(
  run: WorkflowRunSnapshot,
  openPhaseId: string | undefined,
): {
  readonly selection: HumanFormSelection;
  readonly openFormFor: Mock<HumanFormSelection["openFormFor"]>;
} {
  const openFormFor = vi.fn<HumanFormSelection["openFormFor"]>();
  const openForm = run.phaseStates
    .map((phase) => humanFormPhaseFor(run.workflowRunId, phase))
    .find((wait) => wait !== undefined && wait.phaseId === openPhaseId);
  return {
    selection: { openForm, isOpen: (phaseId) => phaseId === openPhaseId, openFormFor },
    openFormFor,
  };
}

/** The phase a park card says it is about. */
function phaseOfCard(card: Element): string {
  return card.querySelector(".meridian-park__phase")?.textContent ?? "";
}

function cardFor(container: HTMLElement, phaseId: string): HTMLElement {
  const card = [...container.querySelectorAll<HTMLElement>(".meridian-park")].find(
    (candidate) => phaseOfCard(candidate) === phaseId,
  );
  if (card === undefined) {
    throw new Error(`no park card is about phase ${phaseId}`);
  }
  return card;
}

function routeControlIn(card: HTMLElement): HTMLButtonElement {
  const control = card.querySelector<HTMLButtonElement>(".meridian-park__form-action");
  if (control === null) {
    throw new Error("the card offered no route to its form");
  }
  return control;
}

describe("a park card's route to its own form", () => {
  it("says the open wait's form is open and offers each other wait a route to its own", () => {
    const run = runWithTwoHumanWaits();
    const { selection, openFormFor } = selectionOver(run, PHASE_SIGN_OFF);
    const { container } = render(<RunParks run={run} humanForms={selection} />);

    const openCard = cardFor(container, PHASE_SIGN_OFF);
    expect(openCard.querySelector(".meridian-park__form-state")?.textContent).toContain(
      "form is open",
    );
    expect(openCard.querySelector(".meridian-park__form-action")).toBeNull();

    const otherCard = cardFor(container, SECOND_WAIT_PHASE_ID);
    expect(otherCard.querySelector(".meridian-park__form-state")).toBeNull();
    const route = routeControlIn(otherCard);

    // A park waiting on provider capacity has no form to reach, so neither line is drawn.
    const providerCard = cardFor(container, PHASE_BUILD);
    expect(
      providerCard.querySelector(".meridian-park__form-state, .meridian-park__form-action"),
    ).toBeNull();

    expect(openFormFor).not.toHaveBeenCalled();
    fireEvent.click(route);
    expect(openFormFor).toHaveBeenCalledExactlyOnceWith(SECOND_WAIT_PHASE_ID);
  });

  it("offers no control on a run with a single wait, and says its form is open", () => {
    const { selection } = selectionOver(PARKED_RUN, PHASE_SIGN_OFF);
    const { container } = render(<RunParks run={PARKED_RUN} humanForms={selection} />);

    expect(container.querySelectorAll(".meridian-park__form-action")).toHaveLength(0);
    const sentences = [...container.querySelectorAll(".meridian-park__form-state")];
    expect(sentences).toHaveLength(1);
    expect(sentences[0]?.textContent).toContain("form is open");
  });

  it("says a wait reported without its handle cannot be opened here, and offers no control", () => {
    // `phaseRunId` and `formRevision` are optional on the wire, so a wait can arrive
    // without what its form is answered through. A control there would be answerable in
    // appearance and unsubmittable in fact.
    const run = runWithAnUnaddressableWait();
    const { selection, openFormFor } = selectionOver(run, undefined);
    const { container } = render(<RunParks run={run} humanForms={selection} />);

    expect(container.querySelectorAll(".meridian-park__form-action")).toHaveLength(0);
    const sentences = [...container.querySelectorAll(".meridian-park__form-state")];
    expect(sentences.map((sentence) => sentence.textContent)).toStrictEqual([
      UNADDRESSABLE_HUMAN_WAIT_DETAIL,
    ]);
    expect(openFormFor).not.toHaveBeenCalled();
  });
});

describe("every park card names its phase", () => {
  it("identifies the phase on each card, so two parked branches are told apart", () => {
    // The two human waits read identically in reason, cause and schedule: the phase is
    // the only thing that says which branch stopped.
    const { container } = render(
      <RunParks run={runWithTwoHumanWaits()} humanForms={NO_FORM_OPEN} />,
    );
    const identified = [...container.querySelectorAll(".meridian-park__phase")].map(
      (element) => element.textContent,
    );

    expect(identified).toStrictEqual([PHASE_BUILD, PHASE_SIGN_OFF, SECOND_WAIT_PHASE_ID]);
  });

  it("shows that identity as a wire figure, since the read carries no authored name", () => {
    const { container } = render(
      <RunParks run={runWithTwoHumanWaits()} humanForms={NO_FORM_OPEN} />,
    );
    const identities = [...container.querySelectorAll(".meridian-park__phase")];

    // Counted first so the loop cannot pass over a run that drew no card.
    expect(identities).toHaveLength(3);
    for (const identity of identities) {
      expect(identity.querySelector(".meridian-figure--wire")?.textContent).toBe(
        identity.textContent,
      );
      expect(identity.querySelector(".meridian-park__phase-name")).toBeNull();
    }
  });
});

describe("the phase graph and the park cards of one run", () => {
  /** The graph, with its renderer chunk fetched and drawn. */
  async function renderGraphAndParks(run: WorkflowRunSnapshot): Promise<HTMLElement> {
    const { container } = render(
      <>
        <RunGraphSection phases={run.phaseStates} />
        <RunParks run={run} humanForms={NO_FORM_OPEN} />
      </>,
    );
    await act(async () => {
      await runGraphLoader.load();
    });
    return container;
  }

  function nodesOf(container: HTMLElement): readonly HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(".react-flow__node")];
  }

  function nodeIdOf(node: HTMLElement): string {
    return node.getAttribute("data-id") ?? "";
  }

  it("draws each park as what it is waiting for, not merely as parked", async () => {
    const container = await renderGraphAndParks(PARKED_RUN);

    const drawn = Object.fromEntries(
      nodesOf(container).map((node) => [
        nodeIdOf(node),
        node.querySelector(".meridian-phase-node")?.getAttribute("data-park") ?? null,
      ]),
    );
    // One phase waits on a person, one is parked on capacity with a readable resume,
    // and the other two are not parked.
    expect(drawn).toStrictEqual({
      [PHASE_DRAFT]: null,
      [PHASE_BUILD]: "scheduled",
      [PHASE_SIGN_OFF]: "awaiting-person",
      [PHASE_PUBLISH]: null,
    });
  });

  it("spends the amber exactly where the park cards spend it", async () => {
    // A node in amber beside a neutral card is one surface telling an operator to look at
    // something the other says needs nobody.
    const container = await renderGraphAndParks(PARKED_RUN);
    const cards = [...container.querySelectorAll(".meridian-park")];
    const cardIds = cards.map(phaseOfCard);
    const amberCardIds = cards
      .filter((card) => card.querySelector(".meridian-chip--attention") !== null)
      .map(phaseOfCard);
    const parkedNodeIds = nodesOf(container)
      .filter((node) => node.querySelector(".meridian-phase-node[data-park]") !== null)
      .map(nodeIdOf);
    const amberNodeIds = nodesOf(container)
      .filter((node) => node.querySelector('.meridian-phase-node[data-park="awaiting-person"]'))
      .map(nodeIdOf);

    expect([...parkedNodeIds].sort()).toStrictEqual([...cardIds].sort());
    expect(amberNodeIds).toStrictEqual(amberCardIds);
    // Named ids, so two empty lists cannot satisfy the equalities above.
    expect(amberCardIds).toStrictEqual([PHASE_SIGN_OFF]);
    expect(cardIds).toHaveLength(2);
  });

  it("captions the graph rather than inferring a topology no read carries", async () => {
    const container = await renderGraphAndParks(PARKED_RUN);

    expect(container.querySelector(".meridian-phase-graph__caption")?.textContent ?? "").toContain(
      "has not been read here",
    );
  });
});
