// The repos section's act half: one mode switch per workspace on the wire at a time.
// Two `repo.executionModeSelect` calls issued before the first settles both run and the last to
// reach the daemon decides, so a second press is not sent. The register is `GenerationLatch`:
// `claim` refuses the second press, `settle` drops a reply landing after teardown, `release`
// (guarded by serial) gives the key back, and `supersedeAll` on dispose ends every claim. A
// rejected call is not caught here; the `finally` releases the key and the rejection propagates.

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts";
import { GenerationLatch } from "@renderer/lib/reads/generation-latch.js";
import type { RepoMountsReading } from "./repo-mounts-model.js";
import type { RepoOperations } from "../repo-operations.js";

/** What an act needs from the half of the section that reads. */
export interface RepoMountsReadingPublisher {
  /** The reading standing right now. Every publish below spreads forward from it. */
  currentReading(): RepoMountsReading;
  publish(reading: RepoMountsReading): void;
  /** Ask for the read that follows an accepted switch. */
  requestRefreshAfterSelect(): void;
}

/** The one call the switch makes, and the publisher it reports through. */
export interface ExecutionModeSelectionsOptions {
  /** The one call this class makes. */
  readonly operations: Pick<RepoOperations, "selectExecutionMode">;
  readonly publisher: RepoMountsReadingPublisher;
}

/** The one mutation this section sends, and the register that holds one per workspace. */
export class ExecutionModeSelections {
  readonly #operations: Pick<RepoOperations, "selectExecutionMode">;
  readonly #publisher: RepoMountsReadingPublisher;
  /** Workspaces with a switch outstanding, keyed by workspace id. Empties with the section. */
  readonly #inFlight = new GenerationLatch();

  public constructor(options: ExecutionModeSelectionsOptions) {
    this.#operations = options.operations;
    this.#publisher = options.publisher;
  }

  /**
   * Record one explicit mode switch, then re-read. A press while this workspace's switch is
   * unanswered sends nothing. An accepted switch re-reads because the workspace transitions
   * `ready -> preparing -> ready` on its existing id and the row has to follow.
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
        this.#publisher.requestRefreshAfterSelect();
      });
    } finally {
      // Read before the release, which makes it false: a finished switch must bring the picker
      // back, but nothing may be published onto a section that is gone.
      const stillStanding = claim.isCurrent;
      claim.release();
      if (stillStanding) {
        this.#publishPending(workspaceId, undefined);
      }
    }
  }

  /** Terminal. A call still on the wire settles into nothing rather than a gone section. */
  public dispose(): void {
    this.#inFlight.supersedeAll();
  }

  /** Publish the pending map with one workspace's entry set, or removed where absent. */
  #publishPending(workspaceId: string, executionMode: ExecutionMode | undefined): void {
    const reading = this.#publisher.currentReading();
    const pendingModeByWorkspaceId = { ...reading.pendingModeByWorkspaceId };
    if (executionMode === undefined) {
      // Deleted, not set to `undefined`: `exactOptionalPropertyTypes` distinguishes them.
      delete pendingModeByWorkspaceId[workspaceId];
    } else {
      pendingModeByWorkspaceId[workspaceId] = executionMode;
    }
    this.#publisher.publish({ ...reading, pendingModeByWorkspaceId });
  }
}

/**
 * The sentence a workspace's controls are held with while a switch is on the wire. It names the
 * pending mode when known, since the row above still shows the mode bound now.
 */
export function selectionInFlightCopy(pendingMode: ExecutionMode | undefined): string {
  const subject = pendingMode === undefined ? "A switch" : `A switch to ${pendingMode}`;
  return `${subject} has been sent for this workspace and the background service has not answered yet. Nothing else is sent until it settles.`;
}
