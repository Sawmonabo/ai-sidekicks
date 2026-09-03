// The artifact pane's ACT half: what a press on one row sends, and what each answer
// leaves standing on the reading the scheduled read published.
//
// Split from `artifact-reader.ts` on the seam `repos/proposal-gate-actions.ts` already
// cuts twice in this repo. The class next door owns the READS: which pair of calls, on
// which of the four reasons, coalesced through the console's one scheduler, and what
// it publishes when one does not answer. This one owns the ACTS: a manifest re-read, a
// payload fetch, and a delete — three calls with three different concurrency rules,
// none of them the scheduler's. Kept together the file was doing both jobs at once,
// which `apps/desktop/AGENTS.md` rejects.
//
// THEY MEET AT ONE OBJECT, WHICH IS THE WHOLE SEAM. `ArtifactActionHost` is the five
// things an act needs from the half that reads: the standing reading, the publish, the
// stamp of the refresh currently in flight, whether the pane is still there, and the
// re-read an accepted act asks for. Nothing else crosses — this class holds no
// scheduler and no triggers, so a read cannot be started from here and an act cannot
// re-arm one.
//
// THE THREE ACTS DO NOT SHARE A CONCURRENCY RULE, AND THAT IS THE POINT OF SPLITTING
// THEM OUT.
//
//   • `readManifest` is idempotent per row and superseded by a refresh: the refresh is
//     already re-reading the same row from the list, so the fresher answer lands
//     either way and there is nothing to reconcile.
//   • `deleteArtifact` establishes that a row is GONE, which no in-flight list read
//     can discover, so it reconciles rather than returning — and only disposal
//     silences it.
//   • `fetchPayload` drops a superseded answer rather than writing it: the reading
//     holds ONE payload, so an answer that lands after the stamp moved would put one
//     artifact's bytes under another's name.

import type { ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { artifactManifestRowFromSummary } from "../../repos/artifact-model.js";
import {
  withReplacedRow,
  withRowRefusal,
  withoutRow,
  withoutRowRefusal,
  type ArtifactDeleteOutcome,
  type ArtifactPaneReading,
  type ArtifactRowActOutcome,
} from "./artifact-pane-reading.js";
import { artifactPayloadReadingFrom, type ArtifactPayloadOutcome } from "./artifact-payload.js";

/**
 * What an act needs from the half of the pane that reads.
 *
 * DECLARED ONCE AND IMPLEMENTED BY THE READER, so the two halves share a contract
 * rather than a field. Every member reads or writes state the reader owns, which is
 * why they are named as the operations they are rather than exposed as the fields they
 * touch — `scheduledReadGeneration` is a stamp an act COMPARES and can never set, and
 * `requestRefreshAfterAct` names the one reason an act may put on the scheduler.
 */
export interface ArtifactActionHost {
  /** The reading standing right now. Every publish below spreads forward from it. */
  currentReading(): ArtifactPaneReading;
  publish(reading: ArtifactPaneReading): void;
  /**
   * Which scheduled read is current.
   *
   * Compared, never interpreted: an act captures it before its call and compares it
   * after, and a value that moved means a refresh has re-read the rows this act was
   * about. It is deliberately NOT the fetch register — see the header.
   */
  scheduledReadGeneration(): number;
  /** Whether the pane behind this reader has gone. The only reason to publish nothing. */
  isDisposed(): boolean;
  /** Ask for the read that follows an act the daemon accepted. */
  requestRefreshAfterAct(): void;
}

export interface ArtifactPaneActionsOptions {
  readonly bridge: ConsoleBridge;
  readonly host: ArtifactActionHost;
}

/** The three acts a row offers, and what each answer writes onto the reading. */
export class ArtifactPaneActions {
  readonly #bridge: ConsoleBridge;
  readonly #host: ArtifactActionHost;

  public constructor(options: ArtifactPaneActionsOptions) {
    this.#bridge = options.bridge;
    this.#host = options.host;
  }

  /**
   * Re-read one artifact's manifest, and put what came back on its row.
   *
   * THIS ASKS FOR NO BYTES, WHICH IS WHY IT IS NOT A DOWNLOAD. `artifactRead` answers
   * a `GrowthArtifactRead` — the manifest NESTED beside a way to reach the payload —
   * and takes an `includePayload` request member, so the two halves of
   * `api-payload-contracts.md §Plan-014`'s `ArtifactReadResponse` are both on the
   * port. This call omits that member, which lands the reply on the DEFERRED arm: a
   * handle and no bytes. Fetching them is `fetchPayload` below — a second act, with
   * its own affordance and its own bound — and this one is a re-read of what a row
   * SAYS.
   *
   * So the served answer is used for the only thing this surface wants from it: the
   * `manifest` REPLACES the listed row, member for member, and any refusal standing
   * against that row clears, because the read just answered for it.
   *
   * A SUPERSEDED RE-READ IS DROPPED HERE, AND THAT ASYMMETRY WITH `deleteArtifact`
   * IS DELIBERATE. This read establishes what one row currently SAYS, and the
   * refresh that superseded it is already re-reading that same row from the list —
   * so the answer that lands is the fresher one either way and there is nothing to
   * reconcile. A delete establishes that the row is GONE, which no in-flight list
   * read can discover, which is why that one reconciles instead of returning.
   */
  public async readManifest(artifactId: string): Promise<ArtifactRowActOutcome> {
    const generation = this.#host.scheduledReadGeneration();
    const answer = await this.#bridge.growth.artifactRead({ artifactId });
    if (generation !== this.#host.scheduledReadGeneration()) {
      return { status: "superseded" };
    }
    if (answer.status === "unavailable") {
      return this.#recordRowRefusal(artifactId, answer);
    }
    const reading = this.#host.currentReading();
    this.#host.publish({
      ...reading,
      // The reply NESTS the envelope beside the payload members, so the row is built
      // from `manifest` and not from the reply: a read is a manifest plus a way to
      // reach the bytes, and this surface renders the first of those two.
      artifacts: withReplacedRow(
        reading.artifacts,
        artifactManifestRowFromSummary(answer.value.manifest),
      ),
      refusalByArtifactId: withoutRowRefusal(reading.refusalByArtifactId, artifactId),
    });
    return { status: "settled" };
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
   * ONE AT A TIME, AND A SUPERSEDED ANSWER IS DROPPED. The reading holds one payload,
   * so a fetch that lands while the participant has asked for another artifact's would
   * put one artifact's bytes under another's name. The stamp answers that, and it
   * answers disposal in the same comparison.
   */
  public async fetchPayload(artifactId: string): Promise<ArtifactPayloadOutcome> {
    const generation = this.#host.scheduledReadGeneration();
    this.#host.publish({
      ...this.#host.currentReading(),
      payload: { status: "fetching", artifactId },
    });
    const answer = await this.#bridge.growth.artifactRead({ artifactId, includePayload: true });
    if (generation !== this.#host.scheduledReadGeneration()) {
      return { status: "superseded" };
    }
    if (answer.status === "unavailable") {
      this.#host.publish({
        ...this.#host.currentReading(),
        payload: { status: "refused", artifactId, refusal: answer },
      });
      return { status: "refused", refusal: answer };
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
   * Delete one artifact, after the participant confirmed the consequence.
   *
   * A SERVED DELETE ESTABLISHES THREE FACTS, AND ALL THREE ARE READ. The reply is a
   * `GrowthArtifactDeleteReceipt` — `payloadDisposition`, `rePublishForeclosed`, and
   * `deletedAt`, every member required (`api-payload-contracts.md §Plan-014`) — and
   * this method used to discard it and publish only the removal, which left the
   * panel's receipt strip permanently unsupplied and its announcement saying the
   * reply carried no disposition. It carries one. The receipt goes onto the reading,
   * where the panel draws it and the pane announces it; the row goes off the list,
   * because leaving it would let a participant keep acting on a manifest the daemon
   * has already destroyed; and the list is read again.
   *
   * The re-read is `terminal-event` because that is what it is: an act completed
   * and what it changed is what the next read will say. It is the same reason
   * `repos/repo-mounts-reader.ts` gives its post-mutation re-read.
   *
   * A SERVED DELETE NEVER RETURNS WITHOUT RECONCILING, WHICH IS WHY DISPOSAL AND
   * SUPERSESSION ARE ASKED SEPARATELY HERE. A participant who confirms Delete and then
   * presses "Read again" bumps the refresh stamp, and the list read that press starts
   * can easily have observed the artifact BEFORE the daemon destroyed it — so
   * returning early on the moved stamp left the destroyed manifest on screen,
   * republished by the racing read and still carrying its controls, until somebody
   * refreshed by hand. Disposal is the only reason to publish nothing: no pane is
   * behind this reader. A live reader whose stamp merely moved still applies the
   * removal and still schedules the re-read, because the fact the answer established
   * is true regardless of which refresh was in flight, and that re-read is the thing
   * that takes the row back off the screen the racing list put it on.
   */
  public async deleteArtifact(artifactId: string): Promise<ArtifactDeleteOutcome> {
    const generation = this.#host.scheduledReadGeneration();
    const answer = await this.#bridge.growth.artifactDelete({ artifactId });
    if (answer.status === "unavailable") {
      // A refusal records an act that did NOT happen, so a stamp that moved under it
      // means the row it was about has since been re-read and the refusal has nothing
      // left to stand beside.
      if (generation !== this.#host.scheduledReadGeneration()) {
        return { status: "superseded" };
      }
      this.#recordRowRefusal(artifactId, answer);
      return { status: "refused", refusal: answer };
    }
    if (this.#host.isDisposed()) {
      return { status: "superseded" };
    }
    const receipt = answer.value;
    const reading = this.#host.currentReading();
    this.#host.publish({
      ...reading,
      artifacts: withoutRow(reading.artifacts, artifactId),
      lastDeleteReceipt: receipt,
      // A payload reading about the artifact just destroyed describes bytes that are
      // gone, so it goes with the row rather than sitting under a manifest the list
      // no longer holds.
      payload:
        reading.payload.status !== "not-checked" && reading.payload.artifactId === artifactId
          ? { status: "not-checked" }
          : reading.payload,
      refusalByArtifactId: withoutRowRefusal(reading.refusalByArtifactId, artifactId),
    });
    this.#host.requestRefreshAfterAct();
    return generation === this.#host.scheduledReadGeneration()
      ? { status: "settled", receipt }
      : { status: "reconciling", receipt };
  }

  #recordRowRefusal(artifactId: string, refusal: ConsoleRefusal): ArtifactRowActOutcome {
    const reading = this.#host.currentReading();
    this.#host.publish({
      ...reading,
      refusalByArtifactId: withRowRefusal(reading.refusalByArtifactId, artifactId, refusal),
    });
    return { status: "refused", refusal };
  }
}
