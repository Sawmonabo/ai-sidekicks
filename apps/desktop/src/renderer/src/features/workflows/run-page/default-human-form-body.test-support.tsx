// What the human-form mount point cases need before they can render a wait or put a press. The
// wait is derived from the probe run through `humanFormPhaseFor`, so a run read that stopped
// carrying a prompt or a schema fails the cases instead of passing on a hand-built phase.

import { fireEvent, render, screen } from "@testing-library/react";

// The schema form opens in two steps; a press straight after `render` would hit a control it
// has not armed yet.
import { resolveSchemaFormChunks } from "../schema-form/hooks/useSchemaForm.test-support.js";
import { PARKED_RUN } from "../workflows-probe.test-support.js";
import { settle } from "@test/helpers/settle.js";
import { humanFormPhaseFor } from "./human-form-phase.js";
import type { WorkflowHumanFormSubmitCall } from "./human-form-submit.js";
import { HumanFormMountPoint } from "./components/HumanFormMountPoint.js";
import type { HumanFormPhase } from "./human-form-mount.js";

export { resolveSchemaFormChunks };

/** The attempt of the second wait a branching run parks, opaque exactly as the wire's is. */
export const SECOND_WAIT_PHASE_RUN_ID = "019b7a10-0280-7aa1-8100-701a11150009";

/** The phase that second wait belongs to. */
export const SECOND_WAIT_PHASE_ID = "security-sign-off";

/** A schema asking for one fractional figure, which a numeric control's default step refuses. */
export const FIGURES_SCHEMA = {
  type: "object",
  properties: {
    ratio: { type: "number", title: "Ratio" },
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
const answerSubmit: WorkflowHumanFormSubmitCall = async (request) => recordedReply(request, 1);

/** One submit the case settles by hand, and what it was asked. */
export interface HeldSubmit extends SubmitProbe {
  readonly serve: () => void;
}

/** What a case that moves the pane from one wait to another holds on to. */
export interface SwitchableMountPoint {
  readonly container: HTMLElement;
  /** Put another wait in the same mount point, or clear it, without unmounting anything above. */
  readonly switchTo: (next: HumanFormPhase | undefined) => Promise<void>;
}

/** What a case mounts the human-form mount point with. */
export interface HumanFormMountPointMounting {
  /** The open wait, or `undefined` for the arm where no phase is waiting on anybody. */
  readonly phase: HumanFormPhase | undefined;
  /** The submit call. One that answers at once where a case has none. */
  readonly submitForm?: WorkflowHumanFormSubmitCall;
}

/**
 * A submit call that records what it was asked and answers at once. Build it once per case: the
 * hook holds its attempt against the call's identity, so a call composed per render resets it.
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
 * A submit call that stays in flight until the case serves it, since the single-flight refusal
 * lives between the press and the answer.
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
export const SUBMIT_FAILURE: Error = new Error("the submit call failed");

/** A submit call that fails the two ways a call can: it rejects, or throws before returning. */
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

/** The mount point with the default body inside it, over the submit call the case supplies. */
export async function renderMountPoint(
  phase: HumanFormPhase | undefined,
  submitForm?: WorkflowHumanFormSubmitCall,
): Promise<HTMLElement> {
  const mounted = await renderSwitchableMountPoint({
    phase,
    ...(submitForm === undefined ? {} : { submitForm }),
  });
  return mounted.container;
}

/**
 * The same mount point, kept addressable so a case can move it to a second wait. The call is
 * fixed once so the switch re-addresses the attempt only because the phase changed. Awaits both
 * schema chunks, since a press before they land hits a closed control.
 */
export async function renderSwitchableMountPoint(
  mounting: HumanFormMountPointMounting,
): Promise<SwitchableMountPoint> {
  await resolveSchemaFormChunks();
  const submitForm = mounting.submitForm ?? answerSubmit;
  const mountPointFor = (phase: HumanFormPhase | undefined): React.JSX.Element => (
    <HumanFormMountPoint phase={phase} submitForm={submitForm} />
  );
  const { container, rerender } = render(mountPointFor(mounting.phase));
  await settle();
  return {
    container,
    switchTo: async (next) => {
      rerender(mountPointFor(next));
      await settle();
    },
  };
}

/**
 * Press the one act the form offers, throwing on a control the form has not armed. A press on a
 * disabled button dispatches nothing, and the narrowing is an assertion so an
 * `<input type="submit">` cannot skip the guard.
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
