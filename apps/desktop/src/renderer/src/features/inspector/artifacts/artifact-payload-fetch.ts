// The artifact list's payload fetch: single-flight across the whole section.
//
// The reading holds one payload, so two racing fetches would put one artifact's bytes under
// another's name, and the older reply could overwrite the newer. A continuation checks its
// own latch round rather than the scheduled read's stamp, since a list read carries the
// payload arm forward and says nothing about anyone's bytes.

import type { ArtifactId } from "@ai-sidekicks/contracts/provider-driver";

import { GenerationLatch, type GenerationClaim } from "@renderer/lib/reads/generation-latch.js";
import { RefusalError } from "@renderer/lib/refusal.js";
import { readArtifactPayload } from "@renderer/services/artifacts/artifact-payload-read.js";
import { abandonedReadRefusal } from "@renderer/services/daemon/daemon-reply.js";
import { artifactManifestRowFrom } from "./artifact-model.js";
import type { ArtifactListReadingPublisher } from "./artifact-list-reading-publisher.js";
import { withReplacedRow } from "./artifact-list-reading.js";
import type { ReadArtifact } from "./services/artifact-reads.js";
import {
  artifactPayloadReadingFrom,
  type ArtifactPayloadOutcome,
} from "@renderer/store/artifacts/artifact-payload.js";

/**
 * The one key the section's payload fetch takes.
 *
 * A constant, not the artifact id: keying by artifact would admit a second press for a
 * second row.
 */
const PAYLOAD_FETCH_KEY = "payload-fetch";

/** What the payload fetch needs: the read call and the reader's publishing half. */
export interface ArtifactPayloadFetchesOptions {
  readonly readArtifact: ReadArtifact;
  readonly publisher: ArtifactListReadingPublisher;
}

/** The section's one payload fetch at a time, and what its answer writes. */
export class ArtifactPayloadFetches {
  readonly #readArtifact: ReadArtifact;
  readonly #publisher: ArtifactListReadingPublisher;
  /** The fetch awaiting its answer. One at a time, and the reading says which. */
  readonly #fetches = new GenerationLatch();

  public constructor(options: ArtifactPayloadFetchesOptions) {
    this.#readArtifact = options.readArtifact;
    this.#publisher = options.publisher;
  }

  /**
   * Ask for one artifact's whole payload, because the user pressed for them.
   *
   * The same call as the manifest re-read, told apart by `includePayload`; a payload too large
   * for one message is read window by window. Never run on mount,
   * because a payload is bounded only by the ingest cap, and not routed through the scheduler,
   * which would make a refresh silently re-fetch bytes. A second press while a fetch is on
   * the wire throws; the `fetching` arm holds the control, so only a caller that offers the
   * act unheld reaches it. A rejected call, or a window that comes back short, propagates and
   * the reading returns to no payload.
   */
  public async fetch(artifactId: ArtifactId): Promise<ArtifactPayloadOutcome> {
    const round = this.#fetches.claim(this, PAYLOAD_FETCH_KEY);
    if (round === undefined) {
      throw new Error(`A payload fetch is already in flight; ${artifactId} was not asked for.`);
    }
    this.#publisher.publish({
      ...this.#publisher.currentReading(),
      payload: { status: "fetching", artifactId },
    });
    try {
      return await this.#awaitAnswer(artifactId, round);
    } finally {
      this.#release(round);
    }
  }

  /** Terminal: a settlement still on the wire finds its round superseded. */
  public dispose(): void {
    this.#fetches.supersedeAll();
  }

  async #awaitAnswer(
    artifactId: ArtifactId,
    round: GenerationClaim,
  ): Promise<ArtifactPayloadOutcome> {
    // A disposal mid-read stops the windows still to come rather than fetching them for nobody.
    const read = await readArtifactPayload(async (request) => {
      if (!round.isCurrent) {
        return { status: "refused", refusal: abandonedReadRefusal() };
      }
      return { status: "served", value: await this.#readArtifact(request) };
    }, artifactId);
    if (!round.isCurrent) {
      return { status: "superseded" };
    }
    if (read.status === "refused") {
      throw new RefusalError(read.refusal);
    }
    const { reply, encoding, content } = read.value;
    const payload = artifactPayloadReadingFrom(artifactId, encoding, content);
    const reading = this.#publisher.currentReading();
    this.#publisher.publish({
      ...reading,
      // The reply's manifest is fresher than the row; dropping it would leave the row stating
      // an older read beside bytes from this one.
      artifacts: withReplacedRow(reading.artifacts, artifactManifestRowFrom(reply.manifest)),
      payload,
    });
    return { status: "settled", payload };
  }

  /**
   * Give the key back, and end a `fetching` arm the call left behind.
   *
   * A settled answer has already replaced the arm; only a rejected call leaves it standing.
   */
  #release(round: GenerationClaim): void {
    const heldByThisRound = round.isCurrent;
    round.release();
    if (!heldByThisRound) {
      return;
    }
    const reading = this.#publisher.currentReading();
    if (reading.payload?.status === "fetching") {
      this.#publisher.publish({ ...reading, payload: undefined });
    }
  }
}
