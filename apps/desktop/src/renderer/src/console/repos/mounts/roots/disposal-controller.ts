// Retiring a worktree: one act, one call, and one settlement.
//
// A person retiring an execution root reads a consequence, consents, and sees what
// happened. The consequence sentence lives in `root-act-model.ts`: retiring records a
// transition and the sweep removes the files afterwards.
//
// The settlement is published into a host rather than off a snapshot of its own, which is
// what `execution-mode-selection.ts`, this family's other act-only class, does. A `snapshot`
// in this console names what a wire reading publishes, and every such class is held to a
// scheduler and the members a trigger set needs. A retirement settlement is the record of
// one act somebody took, it does not go stale, and no refresh policy would re-send it. So
// the settlement lands on the surface that asked, and this class publishes nothing.
//
// A call that rejects is not caught here: the guard is still given back, and the rejection
// propagates to the caller.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { WorktreeId } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { CONTROLLER_DISPOSAL } from "@renderer/console/store/act/use-act-controller.js";
import { useSubjectScopedResource } from "@renderer/console/store/subject-scoped/subject-scoped-resource.js";
import type { RepoOperations } from "@renderer/features/repos/repo-operations.js";
import type { DisposalSubject } from "./root-act-model.js";

/** The one call this controller makes. */
export type DisposalOperations = Pick<RepoOperations, "retireWorktree">;

/** Where one disposal stands. */
export type DisposalReading =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | { readonly status: "settled"; readonly state: string };

/** Nothing sent. */
export const DISPOSAL_IDLE: DisposalReading = { status: "idle" };

/** Where a settlement lands: the surface that asked for the disposal. */
export interface RootDisposalHost {
  /** Record where this disposal stands: the send and the settlement each reach it. */
  recordDisposal(reading: DisposalReading): void;
}

/** What one disposal controller is scoped to, and who it reports to. */
export interface RootDisposalControllerOptions {
  readonly operations: DisposalOperations;
  readonly subject: DisposalSubject;
  readonly host: RootDisposalHost;
}

/** What the hook hands a confirmation: the reading, and the two things it can ask for. */
export interface DisposalBinding {
  readonly reading: DisposalReading;
  readonly send: () => void;
  readonly clear: () => void;
}

/** Sends one root's disposal and reports what came back. */
export class RootDisposalController {
  readonly #operations: DisposalOperations;
  readonly #subject: DisposalSubject;
  readonly #host: RootDisposalHost;
  #inFlight = false;
  #disposed = false;

  public constructor(options: RootDisposalControllerOptions) {
    this.#operations = options.operations;
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
   * Does not overlap itself: a second press while one call is on the wire would send a
   * second disposal for one intent.
   */
  public async send(): Promise<void> {
    if (this.#inFlight || this.#disposed) {
      return;
    }
    this.#inFlight = true;
    this.#host.recordDisposal({ status: "sending" });
    try {
      const reply = await this.#operations.retireWorktree(this.#subject.rootId as WorktreeId);
      if (this.#disposed) {
        return;
      }
      // The reply carries `state` and no cleanup instant, which lands on the status read
      // afterwards.
      this.#host.recordDisposal({ status: "settled", state: reply.state });
    } finally {
      // Released on every exit, rejection included. A guard that survived a failed send
      // would refuse every later press for the life of the confirmation, which is exactly
      // the state a person retries from.
      this.#inFlight = false;
    }
  }
}

/** Bind one root's disposal controller to a confirmation, keyed on the root's id. */
export function useRootDisposal(
  bridge: ConsoleBridge,
  subject: DisposalSubject,
  operations: DisposalOperations,
): DisposalBinding {
  const [reading, setReading] = useState<DisposalReading>(DISPOSAL_IDLE);
  // THE HOST IS ONE OBJECT FOR THE LIFE OF THE SURFACE, over React's own stable state
  // setter: the resource seam holds the factory's product against a key, and a host
  // minted per render would hand the controller a reporter the next pass replaces.
  const host = useMemo<RootDisposalHost>(() => ({ recordDisposal: setReading }), []);
  const { value: controller } = useSubjectScopedResource(
    bridge,
    subject.rootId,
    () => new RootDisposalController({ operations, subject, host }),
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
