// The repos section's ACT half: one mode switch per workspace on the wire at a time,
// and what each answer leaves on the row that sent it.
//
// SPLIT FROM `repo-mounts-reader.ts` ON THE SEAM THIS FAMILY ALREADY USES, and for the
// same reason `proposal-gate-actions.ts` sits beside `proposal-gate-reader.ts`: the
// class next door owns the READ — which calls, on which of the four reasons, and what
// it publishes when one does not answer — and this one owns the ACT, which is a
// different subject with a different collaborator and its own teardown. Together in one
// file they had reached the size `apps/desktop/AGENTS.md` calls two jobs; apart, each
// is one subject with one teardown.
//
// ONE SWITCH PER WORKSPACE AT A TIME, AND THE SECOND PRESS IS REFUSED RATHER THAN SENT.
// Two `repo.executionModeSelect` calls issued before the first settles both run, and
// whichever reaches the daemon LAST decides what the workspace is bound as — so a
// participant who corrected their choice could be left in the mode they corrected away
// from, silently, because both calls succeeded. Refused rather than dropped, because a
// press that produced nothing at all is the silent no-op rule 8 forbids, and the
// refusal names the mode already on the wire so the sentence says what is being waited
// for rather than that something is.
//
// PER WORKSPACE AND NEVER PER SECTION. Two workspaces switching are two mutations on
// two rows that cannot collide, so the register is keyed: a section holding one row's
// picker because another row is waiting would refuse a press for a reason that is not
// about it.
//
// SETTLED BY LIVENESS AND BY REQUEST IDENTITY, WHICH ARE TWO QUESTIONS. A continuation
// that wrote on liveness alone would publish onto a section that had unmounted while
// its call was on the wire — the reachable failure, and the one the tests drive. The
// identity half is what makes the register's own bookkeeping safe: `#release` must not
// give back an entry that is not its own, and if a second switch per workspace ever
// becomes reachable, a reply for a request the register has moved past would otherwise
// write over the newer answer. Both halves are asked in one place, so neither can be
// asked without the other.

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts";
import type { ConsoleBridge } from "../bridge/index.js";
import { refuse, type ConsoleRefusal } from "../core/index.js";
import type { RepoMountsReading } from "./repo-mounts-model.js";
import { REPO_READS_REFUSAL_ORIGIN, selectExecutionMode } from "./repo-reads.js";

/**
 * Why a mode switch failed on the console's side of the wire.
 *
 * One member, and it does not overlap a daemon code: a refused select keeps the
 * daemon's own code verbatim. This names the one failure that is the console's to
 * describe — a press made while this workspace's own switch is still unanswered.
 */
export const EXECUTION_MODE_SELECTION_REFUSAL_CODES = ["selection-in-flight"] as const;

/** One console-side selection refusal code. Derived, so the vocabulary is declared once. */
export type ExecutionModeSelectionRefusalCode =
  (typeof EXECUTION_MODE_SELECTION_REFUSAL_CODES)[number];

/**
 * What a second press is told, naming the switch already on the wire.
 *
 * A FUNCTION RATHER THAN A CONSTANT, because the sentence has to name the pending mode:
 * a participant told "something is in flight" cannot tell what, and the row above is
 * still showing the mode the workspace is bound as NOW, which is the one mode the
 * sentence must not be read as.
 */
export function selectionInFlightCopy(pendingMode: ExecutionMode): string {
  return `A switch to ${pendingMode} has been sent for this workspace and the daemon has not answered yet. Nothing else is sent until it settles.`;
}

/** What an act needs from the half of the section that reads. */
export interface ExecutionModeSelectionHost {
  /** The reading standing right now. Every publish below spreads forward from it. */
  currentReading(): RepoMountsReading;
  publish(reading: RepoMountsReading): void;
  /** Ask for the read that follows a switch the daemon accepted. */
  requestRefreshAfterSelect(): void;
}

/**
 * One switch awaiting the bridge, and the identity that tells it from its successor.
 *
 * The mode is held because the picker has to name it; the id is what makes a
 * settlement attributable.
 */
interface InFlightModeSelection {
  readonly executionMode: ExecutionMode;
  readonly requestId: number;
}

export interface ExecutionModeSelectionsOptions {
  readonly bridge: ConsoleBridge;
  readonly host: ExecutionModeSelectionHost;
}

/** The one mutation this section sends, the register that holds one per workspace. */
export class ExecutionModeSelections {
  readonly #bridge: ConsoleBridge;
  readonly #host: ExecutionModeSelectionHost;
  /** The switch awaiting the bridge on each workspace. One at a time, and the row says which. */
  readonly #inFlightByWorkspaceId = new Map<string, InFlightModeSelection>();
  /** Monotonic across the section, so a superseded continuation matches no standing request. */
  #nextRequestId = 1;
  #disposed = false;

  public constructor(options: ExecutionModeSelectionsOptions) {
    this.#bridge = options.bridge;
    this.#host = options.host;
  }

  /**
   * Record one explicit mode switch, then re-read.
   *
   * A REFUSED switch does not re-read and does not re-pick: `Spec-010 §Required
   * Behavior` forbids silent substitution, and the renderer's half of that is showing
   * the refusal and leaving the choice with the participant. An ACCEPTED switch
   * re-reads, because the workspace transitions `ready -> provisioning -> ready` on its
   * existing id and the row has to follow it.
   */
  public async request(workspaceId: WorkspaceId, executionMode: ExecutionMode): Promise<void> {
    const pending = this.#inFlightByWorkspaceId.get(workspaceId);
    if (pending !== undefined) {
      this.#recordRefusal(
        workspaceId,
        refuse(
          REPO_READS_REFUSAL_ORIGIN,
          "selection-in-flight" satisfies ExecutionModeSelectionRefusalCode,
          selectionInFlightCopy(pending.executionMode),
        ),
      );
      return;
    }
    const request: InFlightModeSelection = { executionMode, requestId: this.#nextRequestId };
    this.#nextRequestId += 1;
    this.#hold(workspaceId, request);
    try {
      const outcome = await selectExecutionMode(this.#bridge, workspaceId, executionMode);
      if (!this.#stillStandingFor(workspaceId, request)) {
        return;
      }
      if (outcome.status === "refused") {
        this.#recordRefusal(workspaceId, outcome.refusal);
        return;
      }
      this.#host.requestRefreshAfterSelect();
    } finally {
      this.#release(workspaceId, request);
    }
  }

  /** Terminal. A call still on the wire settles into nothing rather than onto a section that unmounted. */
  public dispose(): void {
    this.#disposed = true;
    this.#inFlightByWorkspaceId.clear();
  }

  /** Take this workspace's register, and redraw so its picker holds. */
  #hold(workspaceId: string, request: InFlightModeSelection): void {
    this.#inFlightByWorkspaceId.set(workspaceId, request);
    this.#publishPending(workspaceId, request.executionMode);
  }

  /**
   * Give the register back, but only where it is still this request's to give.
   *
   * A disposal clears the register out from under a continuation, and a request that no
   * longer holds it must not clear a successor's — which is the same identity check the
   * settle path makes before it writes.
   */
  #release(workspaceId: string, request: InFlightModeSelection): void {
    if (this.#inFlightByWorkspaceId.get(workspaceId)?.requestId !== request.requestId) {
      return;
    }
    this.#inFlightByWorkspaceId.delete(workspaceId);
    this.#publishPending(workspaceId, undefined);
  }

  /** Whether a settled call still speaks for the switch this workspace's register holds. */
  #stillStandingFor(workspaceId: string, request: InFlightModeSelection): boolean {
    return (
      !this.#disposed &&
      this.#inFlightByWorkspaceId.get(workspaceId)?.requestId === request.requestId
    );
  }

  /**
   * Publish the pending map with one workspace's entry set, or removed where absent.
   *
   * THE TWO BRANCHES ARE THE TWO MOMENTS, and the second one carries the refusal rule.
   * A defined mode reaches this only from `#hold`, which runs when a NEW request takes
   * the register — so that is exactly the moment this workspace's previous selection
   * refusal stops describing anything. Left standing, the picker showed the failure the
   * participant had just retried away from beside "Switching to …" for the whole flight
   * and, on an accepted switch, until the follow-up read replaced the reading. Cleared
   * here rather than in `#hold` so it is ONE publish: two would put the stale refusal
   * and the new pending mode on screen together for a frame.
   *
   * The release path must NOT clear, and that is the whole reason the rule is keyed on
   * the mode rather than on a flag: `#release` runs inside the `finally` that follows
   * the settle, so clearing there would erase the daemon's own refusal a moment after
   * recording it. A refused retry therefore records its own result and keeps it.
   */
  #publishPending(workspaceId: string, executionMode: ExecutionMode | undefined): void {
    const reading = this.#host.currentReading();
    const pendingModeByWorkspaceId = { ...reading.pendingModeByWorkspaceId };
    if (executionMode === undefined) {
      // Deleted rather than set to `undefined`: `exactOptionalPropertyTypes` makes a
      // held key with no value a different thing from an absent one, and the picker
      // asks whether there IS an entry.
      delete pendingModeByWorkspaceId[workspaceId];
      this.#host.publish({ ...reading, pendingModeByWorkspaceId });
      return;
    }
    pendingModeByWorkspaceId[workspaceId] = executionMode;
    const refusalByWorkspaceId = { ...reading.refusalByWorkspaceId };
    delete refusalByWorkspaceId[workspaceId];
    this.#host.publish({ ...reading, pendingModeByWorkspaceId, refusalByWorkspaceId });
  }

  #recordRefusal(workspaceId: string, refusal: ConsoleRefusal): void {
    const reading = this.#host.currentReading();
    this.#host.publish({
      ...reading,
      refusalByWorkspaceId: { ...reading.refusalByWorkspaceId, [workspaceId]: refusal },
    });
  }
}
