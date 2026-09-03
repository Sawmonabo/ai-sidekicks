// A pane with no run, a pane whose read was refused, and a pane holding a parked
// run are three different surfaces, and the arms differ in more than their copy.
//
// The tests assert the KIND modifiers and the mounted regions rather than the
// sentences, because the copy is this family's to reword and what the arms owe is a
// rule: pick a run versus wait for a read versus act on a park, and a start
// affordance offered only where there is no run to compete with it.
//
// TWO BRIDGES, AND THE PAIR IS THE POINT. The workflows scenario scripts the run
// read, so the pane mounted against it shows what a daemon would have said; the
// flagship scenario scripts no workflow reply at all, so the same pane against it
// shows the port's typed refusal. Without the second, a green run would not
// distinguish a pane that reads from one that renders the served arm unconditionally.

import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { FLAGSHIP_SCENARIO } from "../../bridge/scenarios/flagship.js";
import { WORKFLOWS_SCENARIO } from "../../bridge/scenarios/workflows.js";
import { WORKFLOWS_PARKED_RUN } from "../../bridge/scenarios/workflow-fixture-runs.js";
import { parkAwaitsPerson, parkSchedule, phasePark } from "../../workflows/run-list-projection.js";
import type { ConsolePaneContext } from "../../seats/index.js";
import type { ConsoleEntityRef } from "../../store/index.js";
import { RunDetailSlot } from "./slots/RunDetailSlot.js";
import { WorkflowRunPane } from "./WorkflowRunPane.js";

// Spied, never replaced, `ConsoleRoot.test.tsx`'s instrument: the run-detail slot
// carries no body anywhere in this repository, so what the pane handed it reaches no
// rendered markup and there is no other way to read it back. The real wrapper still
// renders, which is why the slot count below is still the pane's own.
vi.mock(import("./slots/RunDetailSlot.js"), { spy: true });

/**
 * What a cast pane context may be addressed at.
 *
 * Any console entity or none — the set the pane's own two guards project, rather than
 * `ConsolePaneAddress`'s own arm for this kind, because the cases below drive exactly
 * the addresses the arm makes unconstructible and the guards still refuse.
 */
type AddressedEntity = ConsoleEntityRef | undefined;

/**
 * The fields the chrome reads, and nothing else.
 *
 * Cast rather than constructed, the idiom `frame/legacy-surfaces.test.ts`
 * established: a real pane context carries three stores, one of which opens a
 * database on construction, and building all of that to hand three fields to a
 * component that reads three fields would make the setup the subject. The bridge is
 * real, because the pane now asks it something.
 */
function paneContext(entity: AddressedEntity, bridge: ConsoleBridge): ConsolePaneContext {
  return {
    kind: "workflow-run",
    entity,
    bridge,
    sessionStore: { sessionId: WORKFLOWS_PARKED_RUN.sessionId },
  } as unknown as ConsolePaneContext;
}

/** A bridge that answers the workflow reads, and one that answers nothing. */
function answeringBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
}
function silentBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
}

function renderPane(context: ConsolePaneContext): HTMLElement {
  const { container } = render(<WorkflowRunPane context={context} />);
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the pane rendered no section");
  }
  return section;
}

const PARKED = { kind: "workflow-run", id: WORKFLOWS_PARKED_RUN.workflowRunId } as const;

// An address this pane must not open. `CONSOLE_ENTITY_KINDS` registers
// `workflow-definition` beside `workflow-run`, and the deck hands a pane whichever
// one its layout carried — so the run view is reachable at a definition, and the id
// under it is a definition id.
const MISADDRESSED = { kind: "workflow-definition", id: "definition-01" } as const;

describe("workflow run pane — the arms and what each offers", () => {
  it("reports an unaddressed pane as empty and offers the start affordance there", async () => {
    const section = renderPane(paneContext(undefined, silentBridge()));
    await waitFor(() => {
      expect(section.querySelector(".meridian-nothing--empty")).not.toBeNull();
    });
    // One slot, and it is the conversational start: a run view with no run offers
    // the start affordance, which is the empty state as designed rather than a
    // fallback.
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(1);
  });

  it("renders the port's refusal when nothing answers the run read", async () => {
    const section = renderPane(paneContext(PARKED, silentBridge()));
    await waitFor(() => {
      expect(section.querySelector(".meridian-refusal--banner")).not.toBeNull();
    });
    // Not an empty run: a refused read says nobody answered, and rendering it as a
    // run with no parked phase would assert something about the daemon that nothing
    // established.
    expect(section.querySelector(".meridian-park")).toBeNull();
  });

  it("renders every parked phase of a run the fixture answers for", async () => {
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    const parkedPhaseCount = WORKFLOWS_PARKED_RUN.phaseStates.filter(
      (phase) => phase.parkReason !== undefined,
    ).length;
    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park")).toHaveLength(parkedPhaseCount);
    });
    // Counted off the fixture rather than written as a literal: the run carries two
    // park kinds at once on purpose, and a hard-coded two would keep passing if the
    // scenario dropped one of them.
    expect(parkedPhaseCount).toBeGreaterThan(1);
    expect(section.querySelector(".meridian-refusal--banner")).toBeNull();
  });

  it("identifies the phase on every park card, so two parked branches are told apart", async () => {
    // The defect: a card rendered reason, cause and schedule and dropped the phase,
    // so a run parked on two branches showed two cards a person could not tell
    // apart. Read off the fixture rather than written out, so a scenario that
    // re-keys its phases moves the expectation with it.
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    const parkedPhaseIds = WORKFLOWS_PARKED_RUN.phaseStates
      .filter((phase) => phase.parkReason !== undefined)
      .map((phase) => phase.phaseId);

    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park")).toHaveLength(parkedPhaseIds.length);
    });
    const identifiedPhases = [...section.querySelectorAll(".meridian-park__phase")].map(
      (element) => element.textContent,
    );

    // Every card carries one, and they are the run's own phase keys in the run's own
    // order. A card that identified nothing renders no such element and fails on
    // length; a card that showed a constant fails on the values, because the
    // fixture's two parks sit on two different phases.
    expect(identifiedPhases).toStrictEqual(parkedPhaseIds);
    expect(new Set(identifiedPhases).size).toBe(parkedPhaseIds.length);
  });

  it("shows that identity as a wire figure, since this read carries no authored name", async () => {
    // The run read serves no phase name, so the pane hands the badge none — and the
    // key it does have is the daemon's own string, which wears the mono provenance
    // signature rather than the face an authored name would have had.
    const section = renderPane(paneContext(PARKED, answeringBridge()));

    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park").length).toBeGreaterThan(1);
    });
    for (const identity of section.querySelectorAll(".meridian-park__phase")) {
      expect(identity.querySelector(".meridian-figure--wire")?.textContent).toBe(
        identity.textContent,
      );
      // The control on the same element: nothing was invented to sit beside the
      // identifier, so the whole slot IS the figure.
      expect(identity.querySelector(".meridian-park__phase-name")).toBeNull();
    }
  });

  it("draws the same key on the graph's nodes, in the same mono face", async () => {
    // The reason the identity is derived once: an operator reading a card is
    // matching it against a node. Two call sites reaching for a member separately
    // would each render something plausible and could disagree without anything
    // failing, which is what this asserts against.
    const section = renderPane(paneContext(PARKED, answeringBridge()));

    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-phase-node__id").length).toBe(
        WORKFLOWS_PARKED_RUN.phaseStates.length,
      );
    });
    const nodeIdentifiers = new Set(
      [...section.querySelectorAll(".meridian-phase-node__id .meridian-figure--wire")].map(
        (element) => element.textContent,
      ),
    );

    for (const identity of section.querySelectorAll(".meridian-park__phase")) {
      expect(nodeIdentifiers).toContain(identity.textContent);
    }
    // Negative control: without this the loop would pass over a run whose cards
    // identified nothing at all, since an empty list satisfies every member claim.
    expect(section.querySelectorAll(".meridian-park__phase").length).toBeGreaterThan(1);
    // And the node's name slot stays empty, because no read reachable here fills it.
    expect(section.querySelectorAll(".meridian-phase-node__name")).toHaveLength(0);
  });

  it("captions the graph rather than inferring a topology no read carries", async () => {
    // The run read answers with an ordered phase array and no dependencies, and no
    // registered read this console can put yields the pinned definition that has
    // them. So the pane hands the graph no topology, the graph draws no connector,
    // and the caption says which of those two facts a person is looking at — where
    // before, an edge per adjacent pair drew a parallel run as a serial chain.
    const section = renderPane(paneContext(PARKED, answeringBridge()));

    await waitFor(() => {
      expect(section.querySelector(".meridian-phase-graph__caption")).not.toBeNull();
    });
    expect(section.querySelector(".meridian-phase-graph__caption")?.textContent ?? "").toContain(
      "has not been read here",
    );
  });

  it("offers no start affordance beside a run it already names", async () => {
    // Negative control for the first case: both would pass over a pane that mounted
    // the same regions on every arm. The addressed arm mounts the run detail and the
    // human form and NOT the start, so a second entry point never competes with the
    // run in front of the operator.
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(2);
    });
  });

  it("states that neither run control is reachable, rather than hiding the question", async () => {
    // "Can I stop this run?" needs no read to answer, and no workflow mutation is
    // settled by any scenario — so both controls render a typed refusal rather than
    // disappearing and leaving an operator waiting for a button.
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-run-controls__control")).toHaveLength(2);
    });
  });
});

describe("workflow run pane — what the graph says a park is waiting for", () => {
  /**
   * What the fixture's phases read as, through the projection's own two readings.
   *
   * Derived rather than written out, because the claim is that the graph agrees with
   * the classifier the park badge takes its tone from — and an expectation written by
   * hand would agree with whichever surface was consulted while writing it. `null`
   * is the not-parked case, which is the attribute being absent rather than present
   * and empty.
   */
  function expectedParkAttentionByPhase(): Map<string, string | null> {
    return new Map(
      WORKFLOWS_PARKED_RUN.phaseStates.map((phase) => {
        const park = phasePark(phase);
        if (park === undefined) {
          return [phase.phaseId, null];
        }
        return [
          phase.phaseId,
          parkAwaitsPerson(parkSchedule(park)) ? "awaiting-person" : "scheduled",
        ];
      }),
    );
  }

  function drawnParkAttentionByPhase(section: HTMLElement): Map<string | null, string | null> {
    return new Map(
      [...section.querySelectorAll(".react-flow__node")].map((node) => [
        node.getAttribute("data-id"),
        node.querySelector(".meridian-phase-node")?.getAttribute("data-park") ?? null,
      ]),
    );
  }

  it("draws each park as what it is waiting for, not merely as parked", async () => {
    // The defect: the graph set a parked flag from `parkReason`'s presence and the
    // sheet gave every parked node the amber border rule 3 reserves for a person
    // being needed — so the fixture's provider-limited phase, which the engine armed
    // a readable resume for, was drawn as demanding somebody while the badge beside
    // it correctly said nobody was being asked for anything.
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-phase-node")).toHaveLength(
        WORKFLOWS_PARKED_RUN.phaseStates.length,
      );
    });

    expect(drawnParkAttentionByPhase(section)).toStrictEqual(expectedParkAttentionByPhase());
    // The fixture carries both kinds at once, so the map above is a claim about two
    // readings rather than one repeated: without this it would pass over a graph that
    // gave every park the same treatment, which is the defect.
    const attentions = [...expectedParkAttentionByPhase().values()].filter(
      (attention) => attention !== null,
    );
    expect(new Set(attentions).size).toBe(2);
  });

  it("spends the amber exactly where the park cards spend it", async () => {
    // One phase, two surfaces, one reading. The card and the node are read together —
    // an operator scanning the graph for what needs them looks to the cards for why —
    // so a node in amber beside a neutral card is one of the two telling them to look
    // at something the other says needs nobody.
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park").length).toBeGreaterThan(1);
    });

    const amberNodes = section.querySelectorAll(
      '.meridian-phase-node[data-park="awaiting-person"]',
    );
    const amberCards = section.querySelectorAll(".meridian-park .meridian-chip--attention");
    expect(amberNodes).toHaveLength(amberCards.length);
    // Named counts rather than an equality that two zeroes would also satisfy: the
    // fixture parks two phases and exactly one of them is waiting on a person.
    expect(amberNodes).toHaveLength(1);
    expect(section.querySelectorAll(".meridian-phase-node[data-park]")).toHaveLength(2);
  });
});

describe("workflow run pane — with an address that names no run", () => {
  it("refuses the address rather than reading a definition id as a run id", async () => {
    // The defect: the pane took `entity.id` off any kind at all, so a definition id
    // addressed here was carried into the run read and whatever came back was shown
    // under an address that never named a run.
    const bridge = answeringBridge();
    const runRead = vi.spyOn(bridge.growth, "workflowRunRead");
    const section = renderPane(paneContext(MISADDRESSED, bridge));

    await waitFor(() => {
      expect(section.querySelector(".meridian-refusal--banner")).not.toBeNull();
    });
    expect(section.textContent ?? "").toContain("pane-address-invalid");
    // The read is not merely refused on arrival — it is never put. A pane that
    // composed one and rendered the refusal anyway would still have asked a daemon
    // about a run that does not exist.
    expect(runRead).not.toHaveBeenCalled();
  });

  it("mounts no body and offers no control for a subject it will not open", async () => {
    const section = renderPane(paneContext(MISADDRESSED, answeringBridge()));

    await waitFor(() => {
      expect(section.querySelector(".meridian-refusal--banner")).not.toBeNull();
    });
    // The refusal is the whole surface: a pane that banned the address and still
    // mounted its slots would offer to stop a run it just said it could not name.
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(0);
    expect(section.querySelectorAll(".meridian-run-controls__control")).toHaveLength(0);
    expect(section.querySelector(".meridian-park")).toBeNull();
  });

  it("negative control: the same pane reads on the kind it does show", async () => {
    // Without this, both cases above pass over a pane that refused every address,
    // which would make the run view unreachable rather than fail-closed.
    const bridge = answeringBridge();
    const runRead = vi.spyOn(bridge.growth, "workflowRunRead");
    const section = renderPane(paneContext(PARKED, bridge));

    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park").length).toBeGreaterThan(0);
    });
    expect(runRead).toHaveBeenCalledWith({ workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId });
    expect(section.querySelector(".meridian-refusal--banner")).toBeNull();
  });
});

describe("workflow run pane — what it hands the run-detail mount", () => {
  afterEach(() => {
    // By name rather than `clearAllMocks`, so a case reads only the render it made.
    vi.mocked(RunDetailSlot).mockClear();
  });

  it("hands over the served snapshot it is already holding, rather than the run id alone", async () => {
    // The pane puts the run read to draw its phase graph and its park cards, so the
    // snapshot is in hand at the moment this mount is composed. A body given only the
    // id would have to issue a second read for the phases, retries and outputs the
    // pane is rendering from right beside it.
    const section = renderPane(paneContext(PARKED, answeringBridge()));

    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park").length).toBeGreaterThan(0);
    });
    const mount = vi.mocked(RunDetailSlot).mock.calls.at(-1)?.[0];
    expect(mount?.workflowRunId).toBe(WORKFLOWS_PARKED_RUN.workflowRunId);
    expect(mount?.snapshot).toStrictEqual(WORKFLOWS_PARKED_RUN);
  });

  it("negative control: a refused read hands over no snapshot key at all", async () => {
    // Absent rather than present-and-empty, and the reason the case above is about
    // the served arm specifically: a body handed a key on this arm would be shown a
    // run the daemon never described. Without this, the case above would pass over a
    // pane that spread a snapshot on every arm.
    const section = renderPane(paneContext(PARKED, silentBridge()));

    await waitFor(() => {
      expect(section.querySelector(".meridian-refusal--banner")).not.toBeNull();
    });
    const mount = vi.mocked(RunDetailSlot).mock.calls.at(-1)?.[0];
    expect(mount).toStrictEqual({ workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId });
  });
});
