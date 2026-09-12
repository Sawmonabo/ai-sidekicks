// The artifact pane's visibility change, and the single flight that keeps it to one
// per row.
//
// A CLASS OF ITS OWN ON `artifact-payload-fetch.ts`'s PRECEDENT, and for the same
// reason: `artifact-actions.ts` is already three acts with three concurrency rules,
// and a fourth written into it would take that file past the size at which
// `apps/desktop/AGENTS.md` says a module is doing two jobs. The rule here is a fourth
// again — single flight PER ROW like the manifest re-read, but reconciling rather than
// dropping like the delete — so it is neither of theirs to host.
//
// SINGLE FLIGHT PER ROW, AND THE TOGGLE IS WHY. The control's LABEL is composed from
// the row's current class: a row reading `local-only` offers "Share with the session",
// and the same row reading `shared` offers "Make local-only". So a second press before
// the first settles is not a duplicate of the first — it is a press against a label the
// daemon has not answered for yet, asking for the class the row is already being moved
// to. Keying the latch by artifact id makes that press unrepresentable rather than
// merely unlikely, and two rows re-classifying at once stay two independent calls.
//
// IT RECONCILES RATHER THAN RETURNING, WHICH IS THE DELETE'S RULE AND NOT THE
// RE-READ'S. A manifest re-read superseded by a refresh is dropped, because the refresh
// is already re-reading that same row and the fresher answer lands either way. A
// visibility change is a MUTATION: the list read that a racing refresh started can
// easily have observed the artifact before the daemon re-classified it, so returning
// early on a moved stamp would leave the old class on screen with nothing scheduled to
// correct it. The served answer is applied and a re-read is asked for, exactly as the
// delete does, and only disposal silences it.
//
// THE CLASS THAT LANDS ON THE ROW IS THE DAEMON'S AND NEVER THE REQUEST'S. This call is
// answered with the settled `visibility`, and a policy-blocked share retains the
// original rather than moving it —
// so writing the requested class onto the row would report a change the daemon
// declined to make, on a row whose own toggle would then offer to undo it.

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  GenerationLatch,
  type CurrentGenerationClaim,
  type GenerationClaim,
} from "../../store/index.js";
import { recordRowRefusal, type ArtifactActionHost } from "./artifact-action-host.js";
import { readGrowthAnswer } from "../growth-call.js";
import {
  withArtifactActInFlight,
  withoutArtifactActInFlight,
  withoutRowRefusal,
  type ArtifactVisibilityUpdateOutcome,
} from "./artifact-pane-reading.js";
import { visibilityUpdateInFlightRefusal } from "./artifact-pane-refusals.js";
import type { ArtifactVisibility } from "../artifacts/artifact-model.js";

export interface ArtifactVisibilityUpdatesOptions {
  readonly bridge: ConsoleBridge;
  readonly host: ArtifactActionHost;
}

/** One visibility change per row at a time, and what its answer writes. */
export class ArtifactVisibilityUpdates {
  readonly #bridge: ConsoleBridge;
  readonly #host: ArtifactActionHost;
  /** The change awaiting the bridge on each row. The reading says which rows those are. */
  readonly #updates = new GenerationLatch();

  public constructor(options: ArtifactVisibilityUpdatesOptions) {
    this.#bridge = options.bridge;
    this.#host = options.host;
  }

  /**
   * Re-classify one artifact, because the user pressed its toggle.
   *
   * THE CALLER SUPPLIES THE CLASS RATHER THAN A DIRECTION. A `toggle(artifactId)`
   * would have to read the row's current class to know what to ask for, which is the
   * same read the label was composed from a render earlier — two readings of one fact
   * with a press between them. The surface composes both from the row it drew, so the
   * request says what it wants and this class never derives it.
   */
  public async update(
    artifactId: string,
    visibility: ArtifactVisibility,
  ): Promise<ArtifactVisibilityUpdateOutcome> {
    const updateRound = this.#updates.claim(this, artifactId);
    if (updateRound === undefined) {
      const refusal = visibilityUpdateInFlightRefusal(artifactId);
      recordRowRefusal(this.#host, artifactId, refusal);
      return { status: "refused", refusal };
    }
    const readRound = this.#host.scheduledReadClaim();
    this.#hold(artifactId);
    try {
      return await this.#awaitAnswer(artifactId, visibility, updateRound, readRound);
    } finally {
      this.#release(artifactId, updateRound);
    }
  }

  /** Terminal. A change still on the wire settles into nothing rather than onto a gone pane. */
  public dispose(): void {
    this.#updates.supersedeAll();
  }

  /** The call, and what its answer writes if this row's round still holds the key. */
  async #awaitAnswer(
    artifactId: string,
    visibility: ArtifactVisibility,
    updateRound: GenerationClaim,
    readRound: CurrentGenerationClaim,
  ): Promise<ArtifactVisibilityUpdateOutcome> {
    const answer = await readGrowthAnswer("artifactVisibilityUpdate", "The visibility change", () =>
      this.#bridge.growth.artifactVisibilityUpdate({ artifactId, visibility }),
    );
    // THIS ROW'S ROUND ANSWERS BOTH DISPOSAL AND SUPERSESSION, and it is asked on every
    // arm: a reply for a round the latch has moved past is about a press whose surface
    // is gone or whose successor is already on the wire.
    if (!updateRound.isCurrent) {
      return { status: "superseded" };
    }
    if (answer.status === "refused") {
      // A refusal records an act that did NOT happen, so a refresh that has since
      // re-read the row leaves it with nothing to stand beside — the same reading the
      // delete's own refusal arm takes.
      if (!readRound.isCurrent) {
        return { status: "superseded" };
      }
      recordRowRefusal(this.#host, artifactId, answer.refusal);
      return { status: "refused", refusal: answer.refusal };
    }
    const settled = answer.value.visibility;
    this.#applySettledClass(artifactId, settled);
    this.#host.requestRefreshAfterAct();
    return readRound.isCurrent
      ? { status: "settled", visibility: settled }
      : { status: "reconciling", visibility: settled };
  }

  /**
   * Put the settled class on the row, and clear the refusal the row was carrying.
   *
   * THE ROW IS EDITED RATHER THAN REPLACED, because this reply is not a manifest. The
   * three members it carries are the id, the class, and the instant — so there is no
   * envelope to rebuild a row from, and rebuilding one from what the console already
   * holds plus one changed member is exactly what this does. The re-read that follows
   * is what re-establishes everything else.
   */
  #applySettledClass(artifactId: string, visibility: ArtifactVisibility): void {
    const reading = this.#host.currentReading();
    const { artifacts } = reading;
    this.#host.publish({
      ...reading,
      artifacts:
        artifacts.kind === "listed"
          ? {
              kind: "listed",
              rows: artifacts.rows.map((row) =>
                row.id === artifactId ? { ...row, visibility } : row,
              ),
            }
          : artifacts,
      refusalByArtifactId: withoutRowRefusal(reading.refusalByArtifactId, artifactId),
    });
  }

  /** Take this row's key, and redraw so its toggle holds. */
  #hold(artifactId: string): void {
    const reading = this.#host.currentReading();
    this.#host.publish({
      ...reading,
      visibilityUpdateInFlightArtifactIds: withArtifactActInFlight(
        reading.visibilityUpdateInFlightArtifactIds,
        artifactId,
      ),
    });
  }

  /**
   * Give this row's key back, but only where it is still this round's to give.
   *
   * `release` is guarded by the round's own serial, so a continuation the latch has
   * moved past frees nothing. The publish is skipped on that arm too: offering a
   * toggle this round no longer holds would offer it while a successor's call is still
   * on the wire.
   */
  #release(artifactId: string, round: GenerationClaim): void {
    const heldByThisRound = round.isCurrent;
    round.release();
    if (!heldByThisRound) {
      return;
    }
    const reading = this.#host.currentReading();
    this.#host.publish({
      ...reading,
      visibilityUpdateInFlightArtifactIds: withoutArtifactActInFlight(
        reading.visibilityUpdateInFlightArtifactIds,
        artifactId,
      ),
    });
  }
}
