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
// SETTLED BY ITS ROUND, NOT MERELY BY LIVENESS. A register alone answers "is one
// pending"; a continuation coming back from its await also has to answer "is the
// pending one MINE", because a reply for a round the latch has moved past describes
// bytes a later act has already superseded. That is `store/generation-latch.ts`'s
// whole subject, so this class takes ONE key from it rather than hand-rolling a
// serial of its own: `claim` refuses the second press, `isCurrent` answers
// supersession and disposal in one question, and `release` frees nothing once the
// round has been superseded.
//
// AND WHICH ARTIFACT IS PENDING IS READ OFF THE READING RATHER THAN HELD TWICE. The
// reading's `fetching` arm names it — that is what the pane holds its control by —
// so the refusal a second press produces and the delete's supersession both consult
// the one published fact instead of a shadow copy that could disagree with it.
//
// AND THE FETCH DOES NOT READ THE REFRESH STAMP. A scheduled list read carries the
// payload arm forward untouched, because it re-establishes which artifacts exist and
// answers nothing about anyone's bytes; settling a fetch on that stamp left the
// reading on `{ status: "fetching" }` with no answer ever coming. Disposal supersedes
// the key instead.

import type { ConsoleBridge } from "../../bridge/index.js";
import { artifactManifestRowFromSummary } from "../artifacts/artifact-model.js";
import { GenerationLatch, type CurrentGenerationClaim } from "../../store/index.js";
import { recordRowRefusal, type ArtifactActionHost } from "./artifact-action-host.js";
import { withReplacedRow, withoutRowRefusal } from "./artifact-pane-reading.js";
import { payloadFetchInFlightRefusal } from "./artifact-pane-refusals.js";
import { artifactPayloadReadingFrom, type ArtifactPayloadOutcome } from "./artifact-payload.js";
import { readGrowthAnswer } from "../growth-call.js";

/**
 * The one key this pane's payload fetch takes.
 *
 * A CONSTANT AND NOT THE ARTIFACT ID, because the rule is one fetch across the whole
 * pane: the reading holds ONE payload, so keying by artifact would admit a second
 * press for a second row and put one artifact's bytes under another's name.
 */
const PAYLOAD_FETCH_KEY = "payload-fetch";

export interface ArtifactPayloadFetchesOptions {
  readonly bridge: ConsoleBridge;
  readonly host: ArtifactActionHost;
}

/** The pane's one payload fetch at a time, and what its answer writes. */
export class ArtifactPayloadFetches {
  readonly #bridge: ConsoleBridge;
  readonly #host: ArtifactActionHost;
  /** The fetch awaiting the bridge. One at a time, and the reading says which. */
  readonly #fetches = new GenerationLatch();

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
   * newer bytes AND the newer manifest it carries. The latch's one key makes the second
   * press unrepresentable rather than merely unlikely: the reading names the pending
   * artifact on its `fetching` arm, which is what the pane holds its control by, and a
   * press that reached here anyway is refused in words rather than ignored.
   */
  public async fetch(artifactId: string): Promise<ArtifactPayloadOutcome> {
    const round = this.#fetches.claim(this, PAYLOAD_FETCH_KEY);
    if (round === undefined) {
      // The sentence names the artifact the pane is WAITING on, which the reading's
      // own `fetching` arm carries; falling back to the pressed one keeps the sentence
      // about a real artifact on an arm the key being held makes unreachable.
      const refusal = payloadFetchInFlightRefusal(this.#pendingArtifactId() ?? artifactId);
      // Recorded against the ROW rather than on the payload arm, which the pending
      // fetch owns: writing the refusal there would take the pane off the in-flight
      // absence it is still genuinely in, and the answer it is waiting for would then
      // land on top of the refusal a moment later.
      recordRowRefusal(this.#host, artifactId, refusal);
      return { status: "refused", refusal };
    }
    this.#host.publish({
      ...this.#host.currentReading(),
      payload: { status: "fetching", artifactId },
    });
    try {
      return await this.#awaitAnswer(artifactId, round);
    } finally {
      round.release();
    }
  }

  /** Terminal. A settlement still on the wire finds its round superseded. */
  public dispose(): void {
    this.#fetches.supersedeAll();
  }

  /** The call, and what its answer writes if this round still holds the key. */
  async #awaitAnswer(
    artifactId: string,
    round: CurrentGenerationClaim,
  ): Promise<ArtifactPayloadOutcome> {
    const answer = await readGrowthAnswer("The payload fetch", () =>
      this.#bridge.growth.artifactRead({ artifactId, includePayload: true }),
    );
    if (!round.isCurrent) {
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
   * Supersede the round where the fetch it holds is for an artifact that is gone.
   *
   * SUPERSEDING THE KEY AND NOT MERELY CLEARING THE ARM, because the round is what a
   * continuation is checked against: the reading names the pending artifact too, but
   * a settlement asks `isCurrent`, so clearing the arm alone leaves the answer
   * admissible. Scoped to the matching artifact — a fetch for a DIFFERENT one is
   * unaffected by this delete and its answer is still wanted.
   *
   * CALLED BEFORE THE DELETE'S OWN PUBLISH, which is what makes reading the pending
   * artifact off the reading correct: the arm still names the fetch in flight, and the
   * publish that clears it happens after this returns.
   *
   * The awaiting call still runs its `finally`; `release` is guarded by the round's
   * own serial, so it finds the key already given up and leaves any successor alone.
   */
  public supersedeFor(artifactId: string): void {
    if (this.#pendingArtifactId() === artifactId) {
      this.#fetches.supersede(this, PAYLOAD_FETCH_KEY);
    }
  }

  /**
   * Which artifact the fetch in flight is for, off the arm the pane renders.
   *
   * The reading is the published fact and the key is the register: asking the reading
   * here rather than shadowing the id beside the latch is what keeps the sentence a
   * refusal reads and the row a delete supersedes from ever disagreeing with what the
   * pane is showing. `undefined` only where no fetch is in flight, because the arm is
   * written in the same tick the key is taken and cleared in the same tick it is given
   * back.
   */
  #pendingArtifactId(): string | undefined {
    const { payload } = this.#host.currentReading();
    return payload.status === "fetching" ? payload.artifactId : undefined;
  }
}
