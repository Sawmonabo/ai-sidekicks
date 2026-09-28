// What every human-form slot suite needs before it can render a wait or put a press.
//
// The wait is derived from the probe run through `humanFormPhaseFor`, never written out,
// so a run read that stopped carrying a prompt or a schema would fail the suites here
// rather than keep passing on a hand-built phase.

import { fireEvent, render, screen } from "@testing-library/react";

// The seat's own wait for its two chunks: the form opens in two steps, and a press
// straight after `render` would hit a control the form has not armed yet.
import { resolveSchemaFormChunks } from "../../../../seats/schema-form/containers/use-schema-form.test-support.js";
import { PARKED_RUN, settle } from "../../../workflows-probe.test-support.js";
import { humanFormPhaseFor } from "../human-form-selection.js";
import type { WorkflowHumanFormSubmitCall } from "../human-form-submit.js";
import { ServedRunActContext, type RecordServedRunAct } from "../served-run-act.js";
import { HumanFormSlot } from "./HumanFormSlot.js";
import type { HumanFormBody, HumanFormPhase } from "./human-form-mount.js";

export { resolveSchemaFormChunks };

/** The attempt of the second wait a branching run parks, opaque exactly as the wire's is. */
export const SECOND_WAIT_PHASE_RUN_ID = "019b7a10-0280-7aa1-8100-701a11150009";

/** The phase that second wait belongs to. */
export const SECOND_WAIT_PHASE_ID = "security-sign-off";

/**
 * A schema asking for one fractional figure and one whole one.
 *
 * `number` and `integer` draw one control and differ only in the precision it admits, so
 * each is the other's negative control.
 */
export const FIGURES_SCHEMA = {
  type: "object",
  properties: {
    ratio: { type: "number", title: "Ratio" },
    attempts: { type: "integer", title: "Attempts" },
  },
} as const;

/** What one submit asked, and the call that recorded it. */
export interface SubmitProbe {
  readonly submitForm: WorkflowHumanFormSubmitCall;
  readonly requests: SubmitRequest[];
}

type SubmitRequest = Parameters<WorkflowHumanFormSubmitCall>[0];
type SubmitReply = Awaited<ReturnType<WorkflowHumanFormSubmitCall>>;

function recordedReply(request: SubmitRequest, outputCount: number): SubmitReply {
  return {
    phaseId: request.phaseId,
    phaseRunId: "019b7a10-0280-7aa1-8100-701a11150005",
    outputCount,
    submittedAt: "2026-01-01T10:02:00.000Z",
  };
}

/** The call answering at once with a recorded submission, for a case that never presses. */
export const answerSubmit: WorkflowHumanFormSubmitCall = async (request) =>
  recordedReply(request, 1);

/** One submit the case settles by hand, and what it was asked. */
export interface HeldSubmit extends SubmitProbe {
  readonly serve: () => void;
}

/** What a case that moves the pane from one wait to another holds on to. */
export interface SwitchableSlot {
  readonly container: HTMLElement;
  /** Put another wait in the same slot, or clear it, without unmounting anything above. */
  readonly switchTo: (next: HumanFormPhase | undefined) => Promise<void>;
}

/** What a case mounts the human-form slot with. */
export interface HumanFormSlotMounting {
  /** The open wait, or `undefined` for the arm where no phase is waiting on anybody. */
  readonly phase: HumanFormPhase | undefined;
  /** The submit call. One that answers at once where a case has none. */
  readonly submitForm?: WorkflowHumanFormSubmitCall;
  /** An owner body, for a case about what a supplied body is handed. */
  readonly body?: HumanFormBody;
  /** The run pane's re-arm, for a case about when a submission moves the run read. */
  readonly recordServedAct?: RecordServedRunAct;
}

/**
 * A submit call that records what it was asked and answers at once.
 *
 * Built once per case, not inside a render: the hook holds its attempt against the
 * call's identity, so a call composed on each render would reset it on every re-render.
 */
export function watchingSubmits(): SubmitProbe {
  const requests: SubmitProbe["requests"] = [];
  return {
    requests,
    submitForm: async (request) => {
      requests.push(request);
      return answerSubmit(request);
    },
  };
}

/**
 * A submit call that stays in flight until the case serves it.
 *
 * The single-flight refusal lives in the window between the press and the answer, which
 * a call that answered on the calling turn would close before it could be observed.
 */
export function holdingSubmits(): HeldSubmit {
  const requests: SubmitProbe["requests"] = [];
  let serveHeld: (() => void) | undefined;
  return {
    requests,
    submitForm: (request) => {
      requests.push(request);
      return new Promise((resolve) => {
        serveHeld = () => {
          resolve(recordedReply(request, 2));
        };
      });
    },
    serve: () => serveHeld?.(),
  };
}

/** What a failing submit call fails with, so a case can tell it from any other failure. */
export const SUBMIT_FAILURE = new Error("the submit call failed");

/**
 * A submit call that fails the two ways a call can: it rejects, or it throws before it
 * returns a promise at all.
 */
export function failingSubmits(failure: "rejects" | "throws"): SubmitProbe {
  const requests: SubmitProbe["requests"] = [];
  return {
    requests,
    submitForm: (request) => {
      requests.push(request);
      if (failure === "throws") {
        throw SUBMIT_FAILURE;
      }
      return Promise.reject(SUBMIT_FAILURE);
    },
  };
}

/** The probe run's waiting phase, resolved the way the run pane resolves it. */
export function fixtureWaitPhase(): HumanFormPhase {
  const wait = PARKED_RUN.phaseStates
    .map((phase) => humanFormPhaseFor(PARKED_RUN.workflowRunId, phase))
    .find((resolved) => resolved !== undefined);
  if (wait === undefined) {
    throw new Error("the probe run parks no addressable phase on a person");
  }
  return wait;
}

/** The slot with the shell inside it, over the submit call the case supplies. */
export async function renderSlot(
  phase: HumanFormPhase | undefined,
  submitForm?: WorkflowHumanFormSubmitCall,
): Promise<HTMLElement> {
  const mounted = await renderSwitchableSlot({
    phase,
    ...(submitForm === undefined ? {} : { submitForm }),
  });
  return mounted.container;
}

/**
 * The same slot, kept addressable so a case can move it to a second wait.
 *
 * The call is fixed once and reused across renders, which is what makes the switch a
 * switch: a fresh call would re-address the attempt for a reason that is not the phase.
 * Awaits both schema chunks, because a press before they land hits a closed control.
 */
export async function renderSwitchableSlot(
  mounting: HumanFormSlotMounting,
): Promise<SwitchableSlot> {
  await resolveSchemaFormChunks();
  const submitForm = mounting.submitForm ?? answerSubmit;
  // Spread on the arm that carries one: `exactOptionalPropertyTypes` refuses an explicit
  // `undefined` on an optional prop.
  const ownerBody = mounting.body === undefined ? {} : { body: mounting.body };
  const slotFor = (phase: HumanFormPhase | undefined): React.JSX.Element => (
    <ServedRunActContext.Provider value={mounting.recordServedAct}>
      <HumanFormSlot phase={phase} submitForm={submitForm} {...ownerBody} />
    </ServedRunActContext.Provider>
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

/**
 * Press the one act the form offers, refusing a control the form has not armed.
 *
 * A press on a disabled button dispatches nothing, so without the throws a case pressing
 * before the schema chunk landed would fail later on a count that names none of that.
 * The narrowing is an assertion so an `<input type="submit">` cannot skip the guard.
 */
export function pressSubmit(): void {
  const submit = screen.getByRole("button", { name: "Submit answer" });
  if (!(submit instanceof HTMLButtonElement)) {
    throw new Error(
      `the "Submit answer" role resolved to <${submit.tagName.toLowerCase()}>, which carries no disabled state to read`,
    );
  }
  if (submit.disabled) {
    throw new Error("the submit control is disabled at press time; the schema chunk never loaded");
  }
  fireEvent.click(submit);
}
