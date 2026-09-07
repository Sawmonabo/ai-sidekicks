// Retiring a worktree and disposing an ephemeral clone: one act, two calls.
//
// ONE CONTROLLER FOR BOTH, BECAUSE THE SURFACE IS ONE. A person disposing of an
// execution root is doing the same thing whichever kind it is — reading a consequence,
// consenting, and seeing what happened — and the difference between `repo.worktreeRetire`
// and `repo.ephemeralCloneDispose` is which id goes on the wire. Two controllers would
// be two copies of one lifecycle, and the confirmation above them would have to know
// which it was talking to in order to read a settlement.
//
// WHAT IS NOT SHARED IS THE CONSEQUENCE SENTENCE, and `root-act-model.ts` keeps those
// apart for the reason that matters: retiring RECORDS a transition and the sweep
// removes the files afterwards, while disposing a clone brings forward a terminal the
// clone would have reached anyway. A shared sentence would have been wrong for one of
// them, and the wrong half is what a person is consenting to.
//
// THE SETTLEMENT IS PUBLISHED AND NOT SWALLOWED. `worktree.retire_conflict` is the
// refusal a root held by a live run takes, and it is the ordinary answer rather than an
// exceptional one — a confirmation that closed on the press and said nothing would
// report a retirement that did not happen as one that did.
//
// AND IT IS PUBLISHED INTO A HOST RATHER THAN OFF A SNAPSHOT OF ITS OWN, which is what
// `execution-mode-selection.ts` and `proposals/proposal-gate-actions.ts` — this
// family's other two act-only classes — already do, and the distinction is real rather
// than cosmetic. A `snapshot` in this console names what a WIRE READING publishes, and
// `test/console/architecture/read-triggers.test.ts` holds every such class to a
// scheduler and the two members a trigger set needs. That is the right rule and this
// is not one of its subjects: a disposal settlement is the record of one act somebody
// took, it does not go stale, and there is no reason a refresh policy could name to
// re-send it. Giving this class a scheduler to satisfy the shape would have armed a
// re-read nothing can reach; giving the same published state a third name would have
// been the same evasion wearing a better word. So the settlement lands where the acts
// beside it land — on the surface that asked — and this class publishes nothing.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { EphemeralCloneId, WorktreeId } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../../bridge/index.js";
import type { ConsoleRefusal } from "../../../core/index.js";
import { CONTROLLER_DISPOSAL, useSubjectScopedResource } from "../../../store/index.js";
import { disposeEphemeralClone, retireWorktree } from "../../repo-reads.js";
import type { DisposalSubject } from "./root-act-model.js";

/** Where one disposal stands. */
export type DisposalReading =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | { readonly status: "settled"; readonly state: string }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** Nothing sent. */
export const DISPOSAL_IDLE: DisposalReading = { status: "idle" };

/** Where a settlement lands: the surface that asked for the disposal. */
export interface RootDisposalHost {
  /**
   * Record where this disposal stands.
   *
   * Called on EVERY arm and on none of them silently — the send, the refusal, and the
   * settlement each reach it — because `Spec-023 §Rules every console surface obeys`
   * admits no silent no-op, and a confirmation that recorded only the happy arm would
   * close over a refusal as though it had worked.
   */
  recordDisposal(reading: DisposalReading): void;
}

/** What one disposal controller is scoped to, and who it reports to. */
export interface RootDisposalControllerOptions {
  readonly bridge: ConsoleBridge;
  readonly subject: DisposalSubject;
  readonly host: RootDisposalHost;
}

/** Sends one root's disposal and reports what came back. */
export class RootDisposalController {
  readonly #bridge: ConsoleBridge;
  readonly #subject: DisposalSubject;
  readonly #host: RootDisposalHost;
  #inFlight = false;
  #disposed = false;

  public constructor(options: RootDisposalControllerOptions) {
    this.#bridge = options.bridge;
    this.#subject = options.subject;
    this.#host = options.host;
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /** Terminal. A reply still on the wire reports into nothing rather than onto a torn-down surface. */
  public dispose(): void {
    this.#disposed = true;
  }

  /**
   * Send this root's disposal.
   *
   * REFUSES TO OVERLAP ITSELF for the attach controller's reason: a second press while
   * one call is on the wire sends a second disposal for one intent, and the second
   * refuses against the first's own work — which reads, on screen, as the disposal
   * having failed.
   */
  public async send(): Promise<void> {
    if (this.#inFlight || this.#disposed) {
      return;
    }
    this.#inFlight = true;
    this.#host.recordDisposal({ status: "sending" });
    try {
      const reply =
        this.#subject.kind === "worktree"
          ? await retireWorktree(this.#bridge, this.#subject.rootId as WorktreeId)
          : await disposeEphemeralClone(this.#bridge, this.#subject.rootId as EphemeralCloneId);
      if (this.#disposed) {
        return;
      }
      this.#host.recordDisposal(
        reply.status === "refused"
          ? { status: "refused", refusal: reply.refusal }
          : // BOTH REPLIES CARRY `state` AND NOTHING ELSE THIS SURFACE READS, which is
            // what lets one reading serve both: the id came from the subject and is not
            // news, and neither reply carries a cleanup instant — that lands on the
            // status read afterwards, which is the section's to report.
            { status: "settled", state: reply.value.state },
      );
    } finally {
      // RELEASED ON EVERY EXIT, refusal and rejection included. A guard that survived a
      // failed send would refuse every later press for the life of the confirmation,
      // which is exactly the state a person retries from.
      this.#inFlight = false;
    }
  }
}

/** What the hook hands a confirmation: the reading, and the two things it can ask for. */
export interface DisposalBinding {
  readonly reading: DisposalReading;
  readonly send: () => void;
  readonly clear: () => void;
}

/**
 * Bind one root's disposal controller to a confirmation.
 *
 * KEYED ON THE KIND AND THE ID TOGETHER. The two id spaces are separate, so a worktree
 * and a clone could in principle carry the same string, and a key of the id alone would
 * hand one root's controller — and one root's settlement — to the other's confirmation.
 */
export function useRootDisposal(bridge: ConsoleBridge, subject: DisposalSubject): DisposalBinding {
  const [reading, setReading] = useState<DisposalReading>(DISPOSAL_IDLE);
  // THE HOST IS ONE OBJECT FOR THE LIFE OF THE SURFACE, over React's own stable state
  // setter: the resource seam holds the factory's product against a key, and a host
  // minted per render would hand the controller a reporter the next pass replaces.
  const host = useMemo<RootDisposalHost>(() => ({ recordDisposal: setReading }), []);
  const { value: controller } = useSubjectScopedResource(
    bridge,
    `${subject.kind} ${subject.rootId}`,
    () => new RootDisposalController({ bridge, subject, host }),
    CONTROLLER_DISPOSAL,
  );
  // A NEW CONTROLLER MEANS A NEW SUBJECT, and the settlement on screen belongs to the
  // old one. Cleared here rather than left standing, so a second row's confirmation
  // never opens already reporting the first row's answer.
  useEffect(() => {
    setReading(DISPOSAL_IDLE);
  }, [controller]);
  const send = useCallback(() => {
    void controller.send();
  }, [controller]);
  // CLEARS WHAT IS ON SCREEN AND CANCELS NOTHING. A call already on the wire is not
  // recallable, and the controller's own guard is what keeps a reopened confirmation
  // from sending a second one behind it.
  const clear = useCallback(() => {
    setReading(DISPOSAL_IDLE);
  }, []);
  return { reading, send, clear };
}
