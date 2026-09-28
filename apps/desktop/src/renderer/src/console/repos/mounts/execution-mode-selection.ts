// The repos section's act half: one mode switch per workspace on the wire at a time.
//
// The reader next door owns the reads: which calls, on which reasons, and what it publishes.
// This class owns the mutation, which is a different subject with its own collaborator and
// its own teardown.
//
// One switch per workspace at a time, and a second press is not sent. Two
// `repo.executionModeSelect` calls issued before the first settles both run, and whichever
// reaches the daemon last decides what the workspace is bound as, so a user who corrected
// their choice could be left in the mode they corrected away from.
//
// The register is the console's `GenerationLatch`, not a second copy of it. `claim` is the
// drop-the-second-press rule, because it answers `undefined` rather than a claim that reports
// itself stale; `settle` is the liveness check, so a reply landing after teardown installs
// nothing; `release` in the `finally` is the give-back, guarded by serial so an abandoned
// call cannot free its successor's key; and `supersedeAll` on dispose ends every claim.
//
// The mode a row is waiting for lives on the reading, where the picker renders it from. The
// latch holds keys and no payload, so the sentence's mode is never read from a second record.
//
// A call that rejects is not caught here. The `finally` still gives the key back and clears
// the pending mode, and the rejection propagates to the caller.

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts";
import { GenerationLatch } from "../../store/index.js";
import type { RepoMountsReading } from "./repo-mounts-model.js";
import type { RepoOperations } from "../repo-operations.js";

/** What an act needs from the half of the section that reads. */
export interface ExecutionModeSelectionHost {
  /** The reading standing right now. Every publish below spreads forward from it. */
  currentReading(): RepoMountsReading;
  publish(reading: RepoMountsReading): void;
  /** Ask for the read that follows an accepted switch. */
  requestRefreshAfterSelect(): void;
}

export interface ExecutionModeSelectionsOptions {
  /** The one call this class makes. */
  readonly operations: Pick<RepoOperations, "selectExecutionMode">;
  readonly host: ExecutionModeSelectionHost;
}

/** The one mutation this section sends, and the register that holds one per workspace. */
export class ExecutionModeSelections {
  readonly #operations: Pick<RepoOperations, "selectExecutionMode">;
  readonly #host: ExecutionModeSelectionHost;
  /**
   * Which workspaces have a switch outstanding, keyed by workspace id.
   *
   * The subject is this object, so the register empties with the section rather than with
   * the bridge, and the key is the workspace because two workspaces switching are two
   * mutations on two rows that cannot collide.
   */
  readonly #inFlight = new GenerationLatch();

  public constructor(options: ExecutionModeSelectionsOptions) {
    this.#operations = options.operations;
    this.#host = options.host;
  }

  /**
   * Record one explicit mode switch, then re-read.
   *
   * A press while this workspace's own switch is still unanswered sends nothing. The
   * picker is already held on the pending mode, so the press can only arrive from a
   * caller that raced the render. An accepted switch re-reads, because the workspace
   * transitions `ready -> provisioning -> ready` on its existing id and the row has to
   * follow it.
   */
  public async request(workspaceId: WorkspaceId, executionMode: ExecutionMode): Promise<void> {
    const claim = this.#inFlight.claim(this, workspaceId);
    if (claim === undefined) {
      return;
    }
    this.#publishPending(workspaceId, executionMode);
    try {
      await this.#operations.selectExecutionMode(workspaceId, executionMode);
      claim.settle(() => {
        this.#host.requestRefreshAfterSelect();
      });
    } finally {
      // Read before the release, because releasing is what makes it false. It is asked at
      // all because the picker must come back for a switch that is over and must not be
      // published onto a section that is gone.
      const stillStanding = claim.isCurrent;
      claim.release();
      if (stillStanding) {
        this.#publishPending(workspaceId, undefined);
      }
    }
  }

  /**
   * How many workspaces hold a switch right now, so a case can assert that a settled and
   * released key leaves nothing behind.
   */
  public get inFlightCount(): number {
    return this.#inFlight.heldKeyCount(this);
  }

  /** Terminal. A call still on the wire settles into nothing rather than onto a section that unmounted. */
  public dispose(): void {
    this.#inFlight.supersedeAll();
  }

  /** Publish the pending map with one workspace's entry set, or removed where absent. */
  #publishPending(workspaceId: string, executionMode: ExecutionMode | undefined): void {
    const reading = this.#host.currentReading();
    const pendingModeByWorkspaceId = { ...reading.pendingModeByWorkspaceId };
    if (executionMode === undefined) {
      // Deleted rather than set to `undefined`: `exactOptionalPropertyTypes` makes a held
      // key with no value a different thing from an absent one, and the picker asks
      // whether there is an entry.
      delete pendingModeByWorkspaceId[workspaceId];
    } else {
      pendingModeByWorkspaceId[workspaceId] = executionMode;
    }
    this.#host.publish({ ...reading, pendingModeByWorkspaceId });
  }
}

/**
 * The sentence a workspace's controls are held with while a switch is on the wire.
 *
 * A function rather than a constant, because it names the pending mode: a user told
 * "something is in flight" cannot tell what, and the row above still shows the mode the
 * workspace is bound as now, which is the one mode the sentence must not be read as. An
 * unnamed switch is still a true sentence, where naming the mode just pressed would be a
 * false one.
 */
export function selectionInFlightCopy(pendingMode: ExecutionMode | undefined): string {
  const subject = pendingMode === undefined ? "A switch" : `A switch to ${pendingMode}`;
  return `${subject} has been sent for this workspace and the daemon has not answered yet. Nothing else is sent until it settles.`;
}
