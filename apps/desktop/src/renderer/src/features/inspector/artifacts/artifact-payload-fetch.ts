// The artifact pane's payload fetch, and the single flight that keeps it to one.
//
// The manifest re-read in `artifact-row-actions.ts` is single-flight per row and superseded by
// a refresh. This fetch is single-flight across the whole pane and is superseded by
// nothing but the pane going away.
//
// The reading holds one payload, which is why: two fetches racing put one artifact's bytes
// under another's name, and their answers can settle in either order, so the older reply
// could overwrite the newer bytes and the newer manifest it carries. The reading names the
// pending artifact on its `fetching` arm, which is what holds the pane's control.
//
// A continuation also has to ask whether the pending fetch is its own, because a reply for
// a round the latch has moved past describes bytes a later act has already superseded.
// That is what the latch's round answers, so this class takes one key from it rather than
// keeping a serial of its own. The fetch does not read the scheduled read's stamp: a list
// read carries the payload arm forward untouched and answers nothing about anyone's bytes.

import { GenerationLatch, type GenerationClaim } from "@renderer/lib/reads/generation-latch.js";
import { artifactManifestRowFrom } from "./artifact-model.js";
import type { ArtifactRowActionHost } from "./artifact-row-action-host.js";
import { withReplacedRow } from "./artifact-list-reading.js";
import type { ReadArtifact } from "./services/artifact-reads.js";
import {
  artifactPayloadReadingFrom,
  type ArtifactPayloadOutcome,
} from "@renderer/store/artifacts/artifact-payload.js";

/**
 * The one key this pane's payload fetch takes.
 *
 * A constant and not the artifact id, because the rule is one fetch across the whole
 * pane: keying by artifact would admit a second press for a second row.
 */
const PAYLOAD_FETCH_KEY = "payload-fetch";

export interface ArtifactPayloadFetchesOptions {
  readonly readArtifact: ReadArtifact;
  readonly host: ArtifactRowActionHost;
}

/** The pane's one payload fetch at a time, and what its answer writes. */
export class ArtifactPayloadFetches {
  readonly #readArtifact: ReadArtifact;
  readonly #host: ArtifactRowActionHost;
  /** The fetch awaiting its answer. One at a time, and the reading says which. */
  readonly #fetches = new GenerationLatch();

  public constructor(options: ArtifactPayloadFetchesOptions) {
    this.#readArtifact = options.readArtifact;
    this.#host = options.host;
  }

  /**
   * Ask for one artifact's bytes, because the user pressed for them.
   *
   * It is the same call as the manifest re-read, told apart by `includePayload`. It runs
   * when asked for and never on mount, because a payload is bounded only by the ingest
   * cap. It is not routed through the scheduler: coalescing it with a list refresh would
   * make a refresh silently re-fetch bytes.
   *
   * One at a time. A second press while a fetch is on the wire throws. The `fetching` arm
   * holds the control, so the throw is reached only by a caller that offers the act
   * without holding its control. A rejected call propagates, and the reading returns to
   * no payload so the control is not held for a fetch that ended.
   */
  public async fetch(artifactId: string): Promise<ArtifactPayloadOutcome> {
    const round = this.#fetches.claim(this, PAYLOAD_FETCH_KEY);
    if (round === undefined) {
      throw new Error(`A payload fetch is already in flight; ${artifactId} was not asked for.`);
    }
    this.#host.publish({
      ...this.#host.currentReading(),
      payload: { status: "fetching", artifactId },
    });
    try {
      return await this.#awaitAnswer(artifactId, round);
    } finally {
      this.#release(round);
    }
  }

  /** Terminal. A settlement still on the wire finds its round superseded. */
  public dispose(): void {
    this.#fetches.supersedeAll();
  }

  /** The call, and what its answer writes if this round still holds the key. */
  async #awaitAnswer(artifactId: string, round: GenerationClaim): Promise<ArtifactPayloadOutcome> {
    const answer = await this.#readArtifact({ artifactId, includePayload: true });
    if (!round.isCurrent) {
      return { status: "superseded" };
    }
    const payload = artifactPayloadReadingFrom(artifactId, answer);
    const reading = this.#host.currentReading();
    this.#host.publish({
      ...reading,
      // The reply also carries the manifest, a fresher reading of the row this fetch was
      // about. Dropping it would leave the row stating what an older read said beside
      // bytes that came from this one.
      artifacts: withReplacedRow(reading.artifacts, artifactManifestRowFrom(answer.manifest)),
      payload,
    });
    return { status: "settled", payload };
  }

  /**
   * Give the key back, and end a `fetching` arm the call left behind.
   *
   * A settled answer has already replaced the arm; only a call that rejected leaves it
   * standing. Nothing is published once the round has been superseded.
   */
  #release(round: GenerationClaim): void {
    const heldByThisRound = round.isCurrent;
    round.release();
    if (!heldByThisRound) {
      return;
    }
    const reading = this.#host.currentReading();
    if (reading.payload?.status === "fetching") {
      this.#host.publish({ ...reading, payload: undefined });
    }
  }
}
