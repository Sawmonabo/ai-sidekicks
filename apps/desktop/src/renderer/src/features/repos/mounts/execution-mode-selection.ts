// The repos section's act half: one mode switch per workspace on the wire at a time.
// Two `repo.executionModeSelect` calls issued before the first settles both run and the last to
// reach the daemon decides, so a second press is not sent. The register is `GenerationLatch`:
// `claim` refuses the second press, `settle` drops a reply landing after teardown, `release`
// (guarded by serial) gives the key back, and `supersedeAll` on dispose ends every claim. A
// rejected switch publishes the service's refusal on its workspace, beside the picker, until that
// workspace's next switch is sent.

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts";
import { coerceToRefusal } from "@renderer/lib/coerce-to-refusal.js";
import { GenerationLatch } from "@renderer/lib/reads/generation-latch.js";
import type { Refusal } from "@renderer/lib/refusal.js";
import type { RepoMountsReading } from "./repo-mounts-model.js";
import type { RepoOperations } from "../repo-operations.js";

/** The subsystem a refused mode switch names, so a refusal says which part of the app sent it. */
const MODE_SWITCH_REFUSAL_ORIGIN = "repo-mode-switch";

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
   * `ready -> preparing -> ready` on its existing id and the row has to follow. A refused switch
   * re-reads nothing: the workspace stays bound as it was.
   */
  public async request(workspaceId: WorkspaceId, executionMode: ExecutionMode): Promise<void> {
    const claim = this.#inFlight.claim(this, workspaceId);
    if (claim === undefined) {
      return;
    }
    this.#publishWorkspace(workspaceId, executionMode, undefined);
    try {
      await this.#operations.selectExecutionMode(workspaceId, executionMode);
      claim.settle(() => {
        this.#publisher.requestRefreshAfterSelect();
      });
    } catch (rejection) {
      claim.settle(() => {
        this.#publishWorkspace(
          workspaceId,
          executionMode,
          coerceToRefusal(
            rejection,
            MODE_SWITCH_REFUSAL_ORIGIN,
            `${MODE_SWITCH_REFUSAL_ORIGIN}-call-failed`,
          ),
        );
      });
    } finally {
      // Read before the release, which makes it false: a finished switch must bring the picker
      // back, but nothing may be published onto a section that is gone.
      const stillStanding = claim.isCurrent;
      claim.release();
      if (stillStanding) {
        const reading = this.#publisher.currentReading();
        this.#publisher.publish({
          ...reading,
          pendingModeByWorkspaceId: withEntry(
            reading.pendingModeByWorkspaceId,
            workspaceId,
            undefined,
          ),
        });
      }
    }
  }

  /** Terminal. A call still on the wire settles into nothing rather than a gone section. */
  public dispose(): void {
    this.#inFlight.supersedeAll();
  }

  /** Publish one workspace's pending switch and its refusal, each removed where absent. */
  #publishWorkspace(
    workspaceId: string,
    pendingMode: ExecutionMode | undefined,
    refusal: Refusal | undefined,
  ): void {
    const reading = this.#publisher.currentReading();
    this.#publisher.publish({
      ...reading,
      pendingModeByWorkspaceId: withEntry(
        reading.pendingModeByWorkspaceId,
        workspaceId,
        pendingMode,
      ),
      refusedModeByWorkspaceId: withEntry(reading.refusedModeByWorkspaceId, workspaceId, refusal),
    });
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

// A copy of `record` with `key` set to `value`, or removed where `value` is absent. Deleted, not
// set to `undefined`: `exactOptionalPropertyTypes` distinguishes them, and a reader asks whether
// there is an entry.
function withEntry<TValue>(
  record: Readonly<Record<string, TValue>>,
  key: string,
  value: TValue | undefined,
): Readonly<Record<string, TValue>> {
  const copy = { ...record };
  if (value === undefined) {
    delete copy[key];
  } else {
    copy[key] = value;
  }
  return copy;
}
