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
// THE REGISTER IS `store/generation-latch.ts`, NOT A SECOND COPY OF IT. This class had
// grown its own: a map of in-flight requests, a monotonic request id, a liveness flag,
// an identity check before every settle, and a guarded give-back — which is, line for
// line, what that latch already is, and it is the sixth family that had written one.
// The place copies of a guard drift is the predicate, and a drifted predicate is a
// stale value on screen that every test still passes. So the rules map onto its three
// entry points and nothing here re-derives them: `claim` IS the refuse-the-second-press
// rule, because it answers `undefined` rather than a claim that reports itself stale;
// `settle` is the liveness-and-identity check, asked in one place because the latch
// asks it in one place; `release` in the `finally` is the give-back, guarded by serial
// so an abandoned call cannot free its successor's key; and `supersedeAll` on dispose
// is what makes a reply landing after teardown install nothing.
//
// THE MODE THE ROW IS WAITING FOR LIVES ON THE READING, WHICH IS WHERE IT WAS ALREADY.
// The latch holds keys and no payload, and that is the right shape here rather than a
// missing feature: `pendingModeByWorkspaceId` is what the picker renders, so reading
// the sentence's mode from anywhere else would be a second record of one fact — the
// defect this file is being cut down for.

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts";
import type { ConsoleBridge } from "../../bridge/index.js";
import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { GenerationLatch } from "../../store/index.js";
import type { RepoMountsReading } from "./repo-mounts-model.js";
import { REPO_READS_REFUSAL_ORIGIN, selectExecutionMode } from "../repo-reads.js";

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
 *
 * TOTAL IN THE MODE, because the flight rule and the mode are held by two different
 * objects: the latch says a switch is outstanding and the reading says which one. The
 * two are written in one act, so the unnamed arm is the degrade-honestly floor rather
 * than a state this class produces — and an unnamed switch is still a true sentence,
 * where naming the mode just pressed would be a false one.
 */
export function selectionInFlightCopy(pendingMode: ExecutionMode | undefined): string {
  const subject = pendingMode === undefined ? "A switch" : `A switch to ${pendingMode}`;
  return `${subject} has been sent for this workspace and the daemon has not answered yet. Nothing else is sent until it settles.`;
}

/** What an act needs from the half of the section that reads. */
export interface ExecutionModeSelectionHost {
  /** The reading standing right now. Every publish below spreads forward from it. */
  currentReading(): RepoMountsReading;
  publish(reading: RepoMountsReading): void;
  /** Ask for the read that follows a switch the daemon accepted. */
  requestRefreshAfterSelect(): void;
}

export interface ExecutionModeSelectionsOptions {
  readonly bridge: ConsoleBridge;
  readonly host: ExecutionModeSelectionHost;
}

/** The one mutation this section sends, the register that holds one per workspace. */
export class ExecutionModeSelections {
  readonly #bridge: ConsoleBridge;
  readonly #host: ExecutionModeSelectionHost;
  /**
   * Which workspaces have a switch outstanding, keyed by workspace id.
   *
   * The subject is THIS object, so the register empties with the section rather than
   * with the bridge, and the key is the workspace because two workspaces switching are
   * two mutations on two rows that cannot collide.
   */
  readonly #inFlight = new GenerationLatch();

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
    const claim = this.#inFlight.claim(this, workspaceId);
    if (claim === undefined) {
      // `claim` REFUSING IS THE RULE, not a value this method then acts on: it answers
      // `undefined` rather than a claim reporting itself stale, so there is no way to
      // dispatch first and discover afterwards that this press was not admitted.
      this.#recordRefusal(
        workspaceId,
        executionMode,
        refuse(
          REPO_READS_REFUSAL_ORIGIN,
          "selection-in-flight" satisfies ExecutionModeSelectionRefusalCode,
          selectionInFlightCopy(this.#host.currentReading().pendingModeByWorkspaceId[workspaceId]),
        ),
      );
      return;
    }
    this.#publishPending(workspaceId, executionMode);
    try {
      const outcome = await selectExecutionMode(this.#bridge, workspaceId, executionMode);
      // ONE SETTLE FOR BOTH ARMS, because liveness is one question however the daemon
      // answered: a reply reaching a section that has been torn down installs nothing,
      // and the latch is what decides that rather than a flag this class keeps.
      claim.settle(() => {
        if (outcome.status === "refused") {
          this.#recordRefusal(workspaceId, executionMode, outcome.refusal);
          return;
        }
        this.#host.requestRefreshAfterSelect();
      });
    } finally {
      // READ BEFORE THE RELEASE, because releasing is what makes it false — and asked
      // at all because the picker must come back for a switch that is over and must
      // NOT be published onto a section that is gone. The release itself is guarded by
      // serial, so an abandoned call cannot free the key its successor holds.
      const stillStanding = claim.isCurrent;
      claim.release();
      if (stillStanding) {
        this.#publishPending(workspaceId, undefined);
      }
    }
  }

  /**
   * How many workspaces hold a switch right now — the register's bound, observable.
   *
   * Read by the assertion that a settled-and-released key leaves NOTHING behind, which
   * is the one property a hand-rolled register loses first: a give-back that misses on
   * one arm leaks a key, and the row it belongs to refuses every later press for the
   * life of the section while every existing case goes on passing.
   */
  public get inFlightCount(): number {
    return this.#inFlight.heldKeyCount(this);
  }

  /** Terminal. A call still on the wire settles into nothing rather than onto a section that unmounted. */
  public dispose(): void {
    this.#inFlight.supersedeAll();
  }

  /**
   * Publish the pending map with one workspace's entry set, or removed where absent.
   *
   * THE TWO BRANCHES ARE THE TWO MOMENTS, and the second one carries the refusal rule.
   * A defined mode reaches this only from the admitted press, which is exactly the
   * moment this workspace's previous selection refusal stops describing anything. Left
   * standing, the picker showed the failure the participant had just retried away from
   * beside "Switching to …" for the whole flight and, on an accepted switch, until the
   * follow-up read replaced the reading. Cleared in the SAME publish as the pending
   * mode: two would put the stale refusal and the new pending mode on screen together
   * for a frame.
   *
   * The release path must NOT clear, and that is the whole reason the rule is keyed on
   * the mode rather than on a flag: the release runs inside the `finally` that follows
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
    // Only the act's own half is cleared. The read's half is the read's to rebuild, and
    // a workspace whose capabilities could not be read has not become readable because
    // someone pressed a button on it.
    const bySelection = { ...reading.workspaceRefusals.bySelection };
    delete bySelection[workspaceId];
    this.#host.publish({
      ...reading,
      pendingModeByWorkspaceId,
      workspaceRefusals: { ...reading.workspaceRefusals, bySelection },
    });
  }

  /**
   * Record one refused switch, with the mode it was about.
   *
   * THE MODE IS THE PRESSED ONE ON BOTH ARMS, and on the in-flight arm that is the
   * whole distinction the sentence beside it draws: the refusal is recorded against the
   * mode the participant just chose, while the SENTENCE names the mode already on the
   * wire. Two different modes, two different jobs — the subject of the refusal, and
   * what it is waiting for — and recording the pending one here would attach the
   * recovery for a mode nobody pressed.
   */
  #recordRefusal(workspaceId: string, executionMode: ExecutionMode, refusal: ConsoleRefusal): void {
    const reading = this.#host.currentReading();
    this.#host.publish({
      ...reading,
      workspaceRefusals: {
        ...reading.workspaceRefusals,
        bySelection: {
          ...reading.workspaceRefusals.bySelection,
          [workspaceId]: { refusal, mode: executionMode },
        },
      },
    });
  }
}
