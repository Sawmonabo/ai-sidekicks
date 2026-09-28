// The artifact pane's manifest re-read: what a press on one row sends, and what the answer
// leaves standing on the reading.
//
// `artifact-reader.ts` owns the scheduled reads. This class owns the re-read, whose
// concurrency rule is not the scheduler's, and delegates the payload fetch to
// `artifact-payload-fetch.ts`. Both meet the reader at `ArtifactActionHost`.
//
// A re-read is single-flight per row and superseded by a refresh: the refresh is already
// re-reading the same row from the list, so the fresher answer lands either way. The
// reading names the rows whose re-reads are outstanding, which is what holds each row's
// control.

import { GenerationLatch, type GenerationClaim } from "../../store/index.js";
import { artifactManifestRowFromSummary } from "../artifacts/artifact-model.js";
import type { ArtifactActionHost } from "./artifact-action-host.js";
import { ArtifactPayloadFetches } from "./artifact-payload-fetch.js";
import {
  withArtifactActInFlight,
  withReplacedRow,
  withoutArtifactActInFlight,
  type ArtifactRowActOutcome,
} from "./artifact-pane-reading.js";
import type { ReadArtifact } from "./artifact-pane-reads.js";
import type { ArtifactPayloadOutcome } from "./artifact-payload.js";

export interface ArtifactPaneActionsOptions {
  readonly readArtifact: ReadArtifact;
  readonly host: ArtifactActionHost;
}

/** The two acts a row offers, and what each answer writes onto the reading. */
export class ArtifactPaneActions {
  readonly #readArtifact: ReadArtifact;
  readonly #host: ArtifactActionHost;
  readonly #payloadFetches: ArtifactPayloadFetches;
  /**
   * The manifest re-read awaiting its answer on each row.
   *
   * Keyed by artifact id and never per pane: two rows re-reading are two calls about two
   * manifests that cannot collide.
   */
  readonly #manifestReads = new GenerationLatch();

  public constructor(options: ArtifactPaneActionsOptions) {
    this.#readArtifact = options.readArtifact;
    this.#host = options.host;
    this.#payloadFetches = new ArtifactPayloadFetches(options);
  }

  /** Fetch one artifact's bytes. The rule is `artifact-payload-fetch.ts`'s. */
  public async fetchPayload(artifactId: string): Promise<ArtifactPayloadOutcome> {
    return this.#payloadFetches.fetch(artifactId);
  }

  /**
   * Re-read one artifact's manifest, and put what came back on its row.
   *
   * This asks for no bytes: the read omits `includePayload`, so the reply lands on the
   * deferred arm. The served `manifest` replaces the listed row member for member. A
   * superseded re-read is dropped, because the refresh that superseded it is already
   * re-reading that row. A second press while the row's re-read is on the wire throws.
   * The panel holds the control while the re-read is in flight, so the throw is reached
   * only by a caller that offers the act without holding its control. A rejected call
   * propagates.
   */
  public async readManifest(artifactId: string): Promise<ArtifactRowActOutcome> {
    const manifestRound = this.#manifestReads.claim(this, artifactId);
    if (manifestRound === undefined) {
      throw new Error(`The manifest of ${artifactId} is already being read.`);
    }
    const readRound = this.#host.scheduledReadClaim();
    this.#holdManifestRead(artifactId);
    try {
      const answer = await this.#readArtifact({ artifactId });
      // Two questions: this row's round says whether this reply is still the one the row
      // is waiting for, and the scheduled read's round says whether a refresh has since
      // re-read the row.
      if (!manifestRound.isCurrent || !readRound.isCurrent) {
        return { status: "superseded" };
      }
      const reading = this.#host.currentReading();
      this.#host.publish({
        ...reading,
        // The reply nests the envelope beside the payload members, so the row is built
        // from `manifest` and not from the reply.
        artifacts: withReplacedRow(
          reading.artifacts,
          artifactManifestRowFromSummary(answer.manifest),
        ),
      });
      return { status: "settled" };
    } finally {
      this.#releaseManifestRead(artifactId, manifestRound);
    }
  }

  /** Terminal. A call still on the wire settles into nothing rather than onto an unmounted pane. */
  public dispose(): void {
    this.#payloadFetches.dispose();
    this.#manifestReads.supersedeAll();
  }

  /** Take this row's key, and redraw so its re-read control holds. */
  #holdManifestRead(artifactId: string): void {
    const reading = this.#host.currentReading();
    this.#host.publish({
      ...reading,
      manifestReadInFlightArtifactIds: withArtifactActInFlight(
        reading.manifestReadInFlightArtifactIds,
        artifactId,
      ),
    });
  }

  /**
   * Give this row's key back, but only where it is still this round's to give.
   *
   * The publish is skipped once the round has been superseded, because offering a control
   * this round no longer holds would offer it while its successor's call is on the wire.
   */
  #releaseManifestRead(artifactId: string, round: GenerationClaim): void {
    const heldByThisRound = round.isCurrent;
    round.release();
    if (!heldByThisRound) {
      return;
    }
    const reading = this.#host.currentReading();
    this.#host.publish({
      ...reading,
      manifestReadInFlightArtifactIds: withoutArtifactActInFlight(
        reading.manifestReadInFlightArtifactIds,
        artifactId,
      ),
    });
  }
}
