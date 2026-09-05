// The artifact pane's payload fetch, and the single flight that keeps it to one.
//
// A CLASS OF ITS OWN BECAUSE IT IS A REGISTER WITH A RULE, and the rule is not the
// one either act next door obeys. `artifact-actions.ts` owns the manifest re-read
// (single-flight PER ROW, superseded by a refresh) and the delete (reconciles rather
// than returns); this owns the payload fetch, which is single-flight across the whole
// pane by its OWN request identity and is superseded by nothing but a delete of the
// artifact it is about or the pane going away.
//
// THE READING HOLDS ONE PAYLOAD, which is the whole reason for the register: two
// fetches racing put one artifact's bytes under another's name, and their answers can
// settle in either order, so the older reply could overwrite the newer bytes AND the
// newer manifest it carries. The register makes the second press unrepresentable
// rather than merely unlikely — the reading names the pending artifact on its
// `fetching` arm, which is what the pane holds its control by.
//
// SETTLED BY REQUEST IDENTITY, NOT MERELY BY LIVENESS. `#inFlight` alone answers "is
// one pending"; a continuation coming back from its await also has to answer "is the
// pending one MINE", because a reply for a request the register has moved past
// describes bytes a later act has already superseded. The id is monotonic within THIS
// register and is only ever compared against this register's own — the manifest reads
// next door mint their own, and no comparison crosses the two.
//
// AND THE FETCH DOES NOT READ THE REFRESH STAMP. A scheduled list read carries the
// payload arm forward untouched, because it re-establishes which artifacts exist and
// answers nothing about anyone's bytes; settling a fetch on that stamp left the
// reading on `{ status: "fetching" }` with no answer ever coming. Disposal is asked
// separately, through the host.

import type { ConsoleBridge } from "../../bridge/index.js";
import { artifactManifestRowFromSummary } from "../../repos/artifacts/index.js";
import { recordRowRefusal, type ArtifactActionHost } from "./artifact-action-host.js";
import {
  payloadFetchInFlightRefusal,
  withReplacedRow,
  withoutRowRefusal,
} from "./artifact-pane-reading.js";
import { artifactPayloadReadingFrom, type ArtifactPayloadOutcome } from "./artifact-payload.js";
import { readGrowthAnswer } from "./growth-call.js";

/**
 * One payload fetch awaiting the bridge, and the identity that tells it from its
 * successor.
 *
 * The artifact is carried so the refusal a second press produces can name what the
 * pane is actually waiting on, rather than reporting that something is in flight.
 */
interface InFlightPayloadFetch {
  readonly artifactId: string;
  readonly requestId: number;
}

export interface ArtifactPayloadFetchesOptions {
  readonly bridge: ConsoleBridge;
  readonly host: ArtifactActionHost;
}

/** The pane's one payload fetch at a time, and what its answer writes. */
export class ArtifactPayloadFetches {
  readonly #bridge: ConsoleBridge;
  readonly #host: ArtifactActionHost;
  /** The fetch awaiting the bridge. One at a time, and the reading says which. */
  #inFlight: InFlightPayloadFetch | undefined;
  /** Monotonic within this register, and compared only against this register's own. */
  #nextRequestId = 1;

  public constructor(options: ArtifactPayloadFetchesOptions) {
    this.#bridge = options.bridge;
    this.#host = options.host;
  }

  /**
   * Ask for one artifact's bytes, because the participant pressed for them.
   *
   * THE SAME METHOD AS `readManifest`, TOLD APART BY `includePayload`. That member is
   * the wire's own discriminator, so this is not a second operation and there is no
   * second refusal to register on the port: one call, two requests, and the reply's
   * own union says which of the two served answers came back.
   *
   * EXPLICIT, ALWAYS, AND NEVER ON MOUNT. A payload is bounded only by the ingest cap,
   * so a fetch that ran because a pane opened would spend a hundred megabytes of
   * somebody's link on a surface they were passing through. It runs when it is asked
   * for and at no other time, which is why it is a control and not an effect.
   *
   * NOT ROUTED THROUGH THE SCHEDULER, and that asymmetry with the pane's two other
   * reads is the point: the scheduler coalesces the reads that RE-ESTABLISH the pane,
   * and a payload fetch establishes something the pane did not have. Coalescing it
   * with a list refresh would mean a refresh silently re-fetched bytes, which is the
   * automatic download this act exists to avoid.
   *
   * ONE AT A TIME, AND THE SECOND PRESS IS REFUSED RATHER THAN QUEUED OR DROPPED. Two
   * fetches in flight is two downloads of the same bounded-only-by-ingest payload, and
   * their answers can settle in either order — so the older reply could overwrite the
   * newer bytes AND the newer manifest it carries. The register below makes the second
   * press unrepresentable rather than merely unlikely: the reading names the pending
   * artifact on its `fetching` arm, which is what the pane holds its control by, and a
   * press that reached here anyway is refused in words rather than ignored.
   */
  public async fetch(artifactId: string): Promise<ArtifactPayloadOutcome> {
    const pending = this.#inFlight;
    if (pending !== undefined) {
      const refusal = payloadFetchInFlightRefusal(pending.artifactId);
      // Recorded against the ROW rather than on the payload arm, which the pending
      // fetch owns: writing the refusal there would take the pane off the in-flight
      // absence it is still genuinely in, and the answer it is waiting for would then
      // land on top of the refusal a moment later.
      recordRowRefusal(this.#host, artifactId, refusal);
      return { status: "refused", refusal };
    }
    const request: InFlightPayloadFetch = { artifactId, requestId: this.#nextRequestId };
    this.#nextRequestId += 1;
    this.#inFlight = request;
    this.#host.publish({
      ...this.#host.currentReading(),
      payload: { status: "fetching", artifactId },
    });
    try {
      return await this.#awaitAnswer(request);
    } finally {
      this.#release(request);
    }
  }

  /** Terminal. A settlement still on the wire finds the register given up. */
  public dispose(): void {
    this.#inFlight = undefined;
  }

  /** The call, and what its answer writes if this request still holds the register. */
  async #awaitAnswer(request: InFlightPayloadFetch): Promise<ArtifactPayloadOutcome> {
    const { artifactId } = request;
    const answer = await readGrowthAnswer("The payload fetch", () =>
      this.#bridge.growth.artifactRead({ artifactId, includePayload: true }),
    );
    if (!this.#stillStanding(request)) {
      return { status: "superseded" };
    }
    if (answer.status === "refused") {
      this.#host.publish({
        ...this.#host.currentReading(),
        payload: { status: "refused", artifactId, refusal: answer.refusal },
      });
      return { status: "refused", refusal: answer.refusal };
    }
    const payload = artifactPayloadReadingFrom(artifactId, answer.value);
    const reading = this.#host.currentReading();
    this.#host.publish({
      ...reading,
      // The reply also carries the manifest, and it is used for what it is: a fresher
      // reading of the row this fetch was about. Dropping it would leave the row
      // stating what an older read said while the bytes beside it came from this one.
      artifacts: withReplacedRow(
        reading.artifacts,
        artifactManifestRowFromSummary(answer.value.manifest),
      ),
      payload,
      refusalByArtifactId: withoutRowRefusal(reading.refusalByArtifactId, artifactId),
    });
    return { status: "settled", payload };
  }

  /**
   * Give the register back, but only where it is still this request's to give.
   *
   * A disposal clears the register out from under a continuation, and a request that
   * no longer holds it must not clear a successor's — which is the same identity check
   * `#stillStanding` makes before a settlement writes.
   */
  #release(request: InFlightPayloadFetch): void {
    if (this.#inFlight?.requestId === request.requestId) {
      this.#inFlight = undefined;
    }
  }

  /**
   * Give up the register where the fetch it holds is for an artifact that is gone.
   *
   * KEYED ON THE REGISTER AND NOT ON THE READING, because the register is what a
   * continuation is checked against: the reading names the pending artifact too, but
   * a settlement asks `#stillStanding`, so clearing the arm without clearing the
   * register leaves the answer admissible. Scoped to the matching artifact — a fetch
   * for a DIFFERENT one is unaffected by this delete and its answer is still wanted.
   *
   * The awaiting call still runs its `finally`; `#release` is identity-checked, so it
   * finds the register already given up and leaves any successor alone.
   */
  public supersedeFor(artifactId: string): void {
    if (this.#inFlight?.artifactId === artifactId) {
      this.#inFlight = undefined;
    }
  }

  /** Whether a settled call still speaks for the fetch the register is holding. */
  #stillStanding(request: InFlightPayloadFetch): boolean {
    return !this.#host.isDisposed() && this.#inFlight?.requestId === request.requestId;
  }
}
