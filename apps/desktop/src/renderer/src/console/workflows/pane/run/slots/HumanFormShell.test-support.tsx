// What every human-form slot suite needs before it can render a wait or put a press.
//
// TWO SUITES, ONE SET OF SCAFFOLDING, on `run-control-dispatch.test-support.tsx`'s own
// reading. One suite is about a single wait being answerable — the prompt, the controls,
// the press, the refusals — and the other is about what the slot does as its inputs move
// underneath it: from one branch's wait to another's, and between the two precisions one
// numeric control admits. Both mount the same slot against the same ports, so that lives
// here rather than in whichever file was written first with the other deep-importing it.
//
// THE WAIT IS DERIVED FROM THE FIXTURE, never written out. `humanFormPhaseFor` is what
// the pane resolves a wait through, so a phase built by hand here would keep passing the
// day the run read stopped carrying a prompt or a schema — which is exactly the state
// this shell closed. A negative control in the suite beside this file asserts the fixture
// really does carry both, so no case driven from this wait can be vacuous.
//
// THE PORTS ARE THE CONSOLE'S OWN. The fixture bridge spread with the one operation a
// case is about, rather than an object shaped like a port: a stand-in would agree with
// whatever the hook did with it, and the unregistered-wire arm in particular is only
// meaningful because it is the refusal the real port composes.

import { fireEvent, render, screen } from "@testing-library/react";

import { SidekicksBridgeProvider } from "../../../../bridge/BridgeProvider.js";
import {
  createFixtureBridge,
  type ConsoleBridge,
  type GrowthPort,
} from "../../../../bridge/index.js";
import { WORKFLOWS_SCENARIO } from "../../../../bridge/scenarios/workflows.js";
import { WORKFLOWS_PARKED_RUN } from "../../../../bridge/scenarios/workflow-fixture-runs.js";
import type { WireErrorEnvelope } from "../../../../core/index.js";
import { schemaFormAnswerMount } from "../../../../seats/index.js";
import { settle } from "../../../../core/settle.test-support.js";
import { humanFormPhaseFor } from "../human-form-selection.js";
import { HumanFormSlot } from "./HumanFormSlot.js";
import type { HumanFormBody, HumanFormPhase } from "./human-form-mount.js";

/**
 * Resolve the schema form's chunk before a case renders a wait.
 *
 * The form arrives as its own chunk, so a mount that begins cold suspends for the turn
 * its module lands in and every synchronous query against the controls runs against the
 * reserved region instead. Awaited once per suite rather than settled per case: the
 * seat's loader memoises the load, so this is the same promise every mount in the file
 * would have joined — and a suite that waits here reads exactly what a person who has
 * already opened one form sees.
 */
export async function loadSchemaFormBody(): Promise<void> {
  await schemaFormAnswerMount.load();
}

/** The refusal a daemon raises on a submission composed against a stale revision. */
export const STALE_REVISION_REFUSAL: WireErrorEnvelope = {
  code: "workflow.form_revision_stale",
  message: "Somebody else answered this phase first; re-read the form before answering.",
};

/** The attempt of the second wait a branching run parks, opaque exactly as the wire's is. */
export const SECOND_WAIT_PHASE_RUN_ID = "019b7a10-0280-7aa1-8100-701a11150009";

/** The phase that second wait belongs to. The definition's own name for it. */
export const SECOND_WAIT_PHASE_ID = "security-sign-off";

/**
 * A schema asking for one fractional figure and one whole one.
 *
 * The pair is the point: `number` and `integer` draw the same control and differ only in
 * what precision it admits, so a case over one of them alone says nothing.
 */
export const FIGURES_SCHEMA = {
  type: "object",
  properties: {
    ratio: { type: "number", title: "Ratio" },
    attempts: { type: "integer", title: "Attempts" },
  },
} as const;

/** What one case asked the port, and the bridge the slot read it through. */
export interface SubmitProbe {
  readonly bridge: ConsoleBridge;
  readonly requests: Parameters<GrowthPort["workflowHumanFormSubmit"]>[0][];
}

/**
 * The fixture bridge with its submit replaced by one the case can watch or refuse.
 *
 * Built ONCE per case rather than inside a render: the dispatch holds its outcome
 * against the port's own identity, so a port composed on each render would re-seed that
 * state every time React re-rendered the form.
 */
export function bridgeWatchingSubmits(refusal?: WireErrorEnvelope): SubmitProbe {
  const fixture = createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
  const requests: Parameters<GrowthPort["workflowHumanFormSubmit"]>[0][] = [];
  const growth: GrowthPort = {
    ...fixture.growth,
    workflowHumanFormSubmit: async (request) => {
      requests.push(request);
      if (refusal !== undefined) {
        // Thrown rather than returned: a scripted daemon refusal rejects, and the live
        // seam will reject with the same shape once the wire lands.
        throw refusal;
      }
      return {
        status: "served",
        value: {
          phaseId: request.phaseId,
          phaseRunId: "019b7a10-0280-7aa1-8100-701a11150005",
          outputCount: 1,
          submittedAt: "2026-01-01T10:02:00.000Z",
        },
      };
    },
  };
  return { bridge: { ...fixture, growth }, requests };
}

/** What a port raises when it fails before it has a promise to reject with. */
export const SUBMIT_DISPATCH_FAILURE = "the bridge was torn down before the submit was put";

/**
 * A bridge whose submit throws on the CALLING turn rather than rejecting.
 *
 * `async` is deliberately absent, and that absence is the whole fixture: an `async` port
 * that throws hands back the rejected promise the settlement seam already reads, which is
 * the case the refusal suite above covers. A port that throws before it returns fails on
 * the turn the dispatch CALLS it — a precondition that raises, a bridge already torn down
 * — so the failure reaches the settlement by a route that has nothing of its own to catch
 * it, and the claim is that the seam settles it anyway.
 */
export function bridgeThrowingSubmits(): SubmitProbe {
  const fixture = createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
  const requests: Parameters<GrowthPort["workflowHumanFormSubmit"]>[0][] = [];
  const growth: GrowthPort = {
    ...fixture.growth,
    workflowHumanFormSubmit: (request) => {
      requests.push(request);
      throw new Error(SUBMIT_DISPATCH_FAILURE);
    },
  };
  return { bridge: { ...fixture, growth }, requests };
}

/** One submit the case settles by hand, and what it was asked. */
export interface HeldSubmit extends SubmitProbe {
  readonly serve: () => void;
}

/**
 * A bridge whose submit stays in flight until the case settles it.
 *
 * The window between the press and the answer is where the waiting state and the
 * single-flight refusal both live, and a port that answered on the calling turn would
 * close it before either could be observed — `run-control-dispatch.test-support.tsx`'s
 * reading, at this family's other dispatch.
 */
export function bridgeHoldingSubmits(): HeldSubmit {
  const fixture = createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
  const requests: Parameters<GrowthPort["workflowHumanFormSubmit"]>[0][] = [];
  let serveHeld: (() => void) | undefined;
  const growth: GrowthPort = {
    ...fixture.growth,
    workflowHumanFormSubmit: async (request) => {
      requests.push(request);
      return new Promise((resolve) => {
        serveHeld = () => {
          resolve({
            status: "served",
            value: {
              phaseId: request.phaseId,
              phaseRunId: "019b7a10-0280-7aa1-8100-701a11150005",
              outputCount: 2,
              submittedAt: "2026-01-01T10:03:00.000Z",
            },
          });
        };
      });
    },
  };
  return { bridge: { ...fixture, growth }, requests, serve: () => serveHeld?.() };
}

/** The fixture's own waiting phase, resolved the way the run pane resolves it. */
export function fixtureWaitPhase(): HumanFormPhase {
  const wait = WORKFLOWS_PARKED_RUN.phaseStates
    .map((phase) => humanFormPhaseFor(WORKFLOWS_PARKED_RUN.workflowRunId, phase))
    .find((resolved) => resolved !== undefined);
  if (wait === undefined) {
    throw new Error("the workflows fixture parks no addressable phase on a person");
  }
  return wait;
}

/** The slot with the shell inside it, under a bridge the case supplies. */
export async function renderSlot(
  phase: HumanFormPhase | undefined,
  bridge?: ConsoleBridge,
): Promise<HTMLElement> {
  const mounted = await renderSwitchableSlot({
    phase,
    ...(bridge === undefined ? {} : { bridge }),
  });
  return mounted.container;
}

/** What a case that moves the pane from one wait to another holds on to. */
export interface SwitchableSlot {
  readonly container: HTMLElement;
  /**
   * Put another wait in the same slot, or clear it, without unmounting anything above.
   *
   * Awaited for the reason the mount is: the form the second wait opens is a second form,
   * and it opens in the same two steps.
   */
  readonly switchTo: (next: HumanFormPhase | undefined) => Promise<void>;
}

/**
 * What a case mounts the human-form slot with.
 *
 * An object rather than three positional parameters, and the reason it exists at all is
 * that the seat's own submit channel reads its port off the provider — so every case
 * that opens a wait has to mount one, and every case that supplies an owner body has to
 * mount the same one. Written out per suite, that is three chances to forget the
 * provider and get a thrown bridge resolution instead of the claim under test.
 */
export interface HumanFormSlotMounting {
  /** The open wait, or `undefined` for the arm where no phase is waiting on anybody. */
  readonly phase: HumanFormPhase | undefined;
  /** The bridge the channel reads through. A fresh fixture one where a case has none. */
  readonly bridge?: ConsoleBridge;
  /** An owner body, for a case about what a supplied body is handed. */
  readonly body?: HumanFormBody;
}

/**
 * The same slot, kept addressable so a case can move it to a second wait.
 *
 * The bridge is composed ONCE and reused across both renders, which is what makes the
 * switch a switch: a fresh bridge would re-address every subject-scoped holder in the
 * tree and reset the form for a reason that has nothing to do with the phase.
 *
 * AND IT SETTLES, because the form opens in two steps. `loadSchemaFormBody` above resolves
 * the seat's own chunk; the schema COMPILER is a second one, fetched by the form's own
 * hook when it mounts, and the one act this shell offers is closed until it lands — so a
 * case that pressed submit straight after `render` would press a control the form has
 * deliberately not armed yet.
 */
export async function renderSwitchableSlot(
  mounting: HumanFormSlotMounting,
): Promise<SwitchableSlot> {
  const held = mounting.bridge ?? createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
  // Spread on the arm that carries one rather than passed as an explicit `undefined`,
  // which `exactOptionalPropertyTypes` refuses on an optional prop.
  const ownerBody = mounting.body === undefined ? {} : { body: mounting.body };
  const slotFor = (phase: HumanFormPhase | undefined): React.JSX.Element => (
    <SidekicksBridgeProvider bridge={held}>
      <HumanFormSlot phase={phase} {...ownerBody} />
    </SidekicksBridgeProvider>
  );
  const { container, rerender } = render(slotFor(mounting.phase));
  await settle();
  return {
    container,
    switchTo: async (next) => {
      rerender(slotFor(next));
      await settle();
    },
  };
}

/** Press the one act the form offers. */
export function pressSubmit(): void {
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
}
