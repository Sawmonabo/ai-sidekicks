// The artifact list's manifest re-read: what a press on one row sends, and what the answer
// leaves standing on the reading.
//
// A re-read is single-flight per row and superseded by a refresh, which is already re-reading
// the same row. The payload fetch lives in `artifact-payload-fetch.ts`; both meet the reader
// at `ArtifactListReadingPublisher`.

import type { ArtifactId } from "@ai-sidekicks/contracts";

import { GenerationLatch, type GenerationClaim } from "@renderer/lib/reads/generation-latch.js";
import { artifactManifestRowFrom } from "./artifact-model.js";
import type { ArtifactListReadingPublisher } from "./artifact-list-reading-publisher.js";
import { ArtifactPayloadFetches } from "./artifact-payload-fetch.js";
import {
  withArtifactActInFlight,
  withReplacedRow,
  withoutArtifactActInFlight,
  type ArtifactRowActOutcome,
} from "./artifact-list-reading.js";
import type { ReadArtifact } from "./services/artifact-reads.js";
import type { ArtifactPayloadOutcome } from "@renderer/store/artifacts/artifact-payload.js";

/** What the row acts need: the read call and the reader's publishing half. */
export interface ArtifactRowActionsOptions {
  readonly readArtifact: ReadArtifact;
  readonly publisher: ArtifactListReadingPublisher;
}

/** The two acts a row offers, and what each answer writes onto the reading. */
export class ArtifactRowActions {
  readonly #readArtifact: ReadArtifact;
  readonly #publisher: ArtifactListReadingPublisher;
  readonly #payloadFetches: ArtifactPayloadFetches;
  /** The manifest re-read awaiting its answer on each row, keyed by artifact id. */
  readonly #manifestReads = new GenerationLatch();

  public constructor(options: ArtifactRowActionsOptions) {
    this.#readArtifact = options.readArtifact;
    this.#publisher = options.publisher;
    this.#payloadFetches = new ArtifactPayloadFetches(options);
  }

  /** Fetch one artifact's bytes; the single-flight rule is `artifact-payload-fetch.ts`'s. */
  public async fetchPayload(artifactId: ArtifactId): Promise<ArtifactPayloadOutcome> {
    return this.#payloadFetches.fetch(artifactId);
  }

  /**
   * Re-read one artifact's manifest, and put what came back on its row.
   *
   * Asks for no bytes (no `includePayload`). A re-read a refresh superseded is dropped. A
   * second press while the row's re-read is on the wire throws; the section holds the control,
   * so only a caller that offers the act unheld reaches it. A rejected call propagates.
   */
  public async readManifest(artifactId: ArtifactId): Promise<ArtifactRowActOutcome> {
    const manifestRound = this.#manifestReads.claim(this, artifactId);
    if (manifestRound === undefined) {
      throw new Error(`The manifest of ${artifactId} is already being read.`);
    }
    const readRound = this.#publisher.scheduledReadClaim();
    this.#holdManifestRead(artifactId);
    try {
      const answer = await this.#readArtifact({ artifactId });
      // This row's round says whether the reply is still awaited; the scheduled read's round
      // says whether a refresh has since re-read the row.
      if (!manifestRound.isCurrent || !readRound.isCurrent) {
        return { status: "superseded" };
      }
      const reading = this.#publisher.currentReading();
      this.#publisher.publish({
        ...reading,
        // The reply nests the manifest beside the payload members.
        artifacts: withReplacedRow(reading.artifacts, artifactManifestRowFrom(answer.manifest)),
      });
      return { status: "settled" };
    } finally {
      this.#releaseManifestRead(artifactId, manifestRound);
    }
  }

  /** Terminal: a call still on the wire settles into nothing. */
  public dispose(): void {
    this.#payloadFetches.dispose();
    this.#manifestReads.supersedeAll();
  }

  #holdManifestRead(artifactId: string): void {
    const reading = this.#publisher.currentReading();
    this.#publisher.publish({
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
   * Publishing after supersession would offer the control while the successor's call is on
   * the wire.
   */
  #releaseManifestRead(artifactId: string, round: GenerationClaim): void {
    const heldByThisRound = round.isCurrent;
    round.release();
    if (!heldByThisRound) {
      return;
    }
    const reading = this.#publisher.currentReading();
    this.#publisher.publish({
      ...reading,
      manifestReadInFlightArtifactIds: withoutArtifactActInFlight(
        reading.manifestReadInFlightArtifactIds,
        artifactId,
      ),
    });
  }
}
