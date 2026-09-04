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
//   • `readManifest` is SINGLE-FLIGHT PER ROW and superseded by a refresh: the refresh
//     is already re-reading the same row from the list, so the fresher answer lands
//     either way and there is nothing to reconcile. The per-row register is what makes
//     "idempotent" true rather than hoped for — see below.
//   • `deleteArtifact` establishes that a row is GONE, which no in-flight list read
//     can discover, so it reconciles rather than returning — and only disposal
//     silences it. It is also the one act that SUPERSEDES another: bytes belonging
//     to a manifest the daemon has destroyed are not a reading anybody may publish.
//   • `fetchPayload` is SINGLE-FLIGHT, by its own request identity rather than by the
//     reader's refresh stamp. The reading holds ONE payload, so two fetches racing put
//     one artifact's bytes under another's name.
//
// WHY THE FETCH HAS AN IDENTITY OF ITS OWN AND NO LONGER READS THE REFRESH STAMP.
// Both questions used to be answered by the reader's `#generation`, and that conflated
// two facts that move independently. A list refresh landing under a fetch bumped the
// stamp, so the fetch returned `superseded` and published nothing — leaving the
// reading on `{ status: "fetching" }` with no answer ever coming, which is precisely
// the state the held control below would have locked forever. A scheduled read does
// not supersede a payload fetch: `#performRead` carries the payload arm forward
// untouched, because a list read re-establishes which artifacts exist and answers
// nothing about anyone's bytes. So the fetch is settled by ITS OWN id, and disposal is
// asked separately.
//
// AND THE RE-READ HAS AN IDENTITY OF ITS OWN, BECAUSE THE REFRESH STAMP IS NOT ONE.
// Two presses on one row before the first settles capture the SAME
// `scheduledReadGeneration` — starting an act does not advance it, and it is the
// reader's to move — so both continuations passed the supersession check and whichever
// reply the bridge delivered LAST decided what the row says. Two reads of one manifest
// can settle in either order, so that is the older answer overwriting the newer one,
// silently, on a row the participant pressed twice precisely because they wanted the
// fresher reading. The request's identity is therefore minted AT ISSUE — the keyed
// register `execution-mode-selection.ts` already uses one directory over, keyed by
// artifact id because two rows re-reading are two independent calls that cannot collide
// — and the reading names the rows whose reads are outstanding, which is what holds
// each one's control. A press that reached here anyway is refused in words.
//
// SETTLED BY REQUEST IDENTITY, NOT MERELY BY LIVENESS. `#inFlightFetch` alone answers
// "is one pending"; a continuation coming back from its await also has to answer "is
// the pending one MINE", because a reply for a request the register has moved past
// describes bytes a later act has already superseded, and writing it would put the
// older payload back on the reading.
//
// AND A CALL THAT REJECTS IS AN ANSWER, WHICH IS WHY NO ACT HERE AWAITS THE PORT
// BARE. The live bridge crosses a process boundary, so an IPC disconnect makes the
// call THROW rather than answer a refusal — and a thrown fetch never reached
// `growthAnswerReading` at all: the `finally` gave the register back while the
// reading stayed on `{ status: "fetching" }`, which is the arm the pane holds its
// control by and the arm a scheduled list read deliberately carries forward. The
// pane was then stuck until it was remounted. Every act goes through
// `readGrowthAnswer` (`growth-call.ts`), which reads a rejection as the refusal it is
// through the repos family's one rejection normalizer, so a disconnect lands on the
// same refused arm a typed wire refusal does and the control comes back. It is a
// module of its own because the READ half needs the same door, and a second copy
// would be two chances to relabel a code the console may not paraphrase.

import type { ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { artifactManifestRowFromSummary } from "../../repos/artifact-model.js";
import { readGrowthAnswer } from "./growth-call.js";
import {
  manifestReadInFlightRefusal,
  payloadFetchInFlightRefusal,
  withManifestReadInFlight,
  withReplacedRow,
  withRowRefusal,
  withoutManifestReadInFlight,
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

/**
 * One manifest re-read awaiting the bridge, and the identity that tells it from its
 * successor.
 *
 * The artifact is carried because the register is keyed by it and a released entry has
 * to name which row's control comes back; the id is what makes a settlement
 * attributable to the request that issued it rather than to whichever one is standing.
 */
interface InFlightManifestRead {
  readonly artifactId: string;
  readonly requestId: number;
}

export interface ArtifactPaneActionsOptions {
  readonly bridge: ConsoleBridge;
  readonly host: ArtifactActionHost;
}

/** The three acts a row offers, and what each answer writes onto the reading. */
export class ArtifactPaneActions {
  readonly #bridge: ConsoleBridge;
  readonly #host: ArtifactActionHost;
  /** The payload fetch awaiting the bridge. One at a time, and the reading says which. */
  #inFlightFetch: InFlightPayloadFetch | undefined;
  /**
   * The manifest re-read awaiting the bridge on each row. One per row, and the reading
   * says which rows those are.
   *
   * KEYED AND NEVER PER PANE, on `execution-mode-selection.ts`'s reason for its own
   * keyed register: two rows re-reading are two calls about two manifests that cannot
   * collide, and a pane holding one row's control because another row is waiting would
   * hold it for a reason that is not about it.
   */
  readonly #inFlightManifestReadByArtifactId = new Map<string, InFlightManifestRead>();
  /** Monotonic across both registers, so a superseded continuation matches no standing request. */
  #nextRequestId = 1;

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
   *
   * ONE PER ROW, AND THE SECOND PRESS IS REFUSED RATHER THAN SENT. Two reads of one
   * manifest settle in either order, and the refresh stamp cannot tell them apart
   * because neither of them moved it — see the header. So the request takes this row's
   * register at issue, the reading names the row while it is held, and a settlement
   * whose request the register has moved past writes nothing.
   */
  public async readManifest(artifactId: string): Promise<ArtifactRowActOutcome> {
    if (this.#inFlightManifestReadByArtifactId.has(artifactId)) {
      return this.#recordRowRefusal(artifactId, manifestReadInFlightRefusal(artifactId));
    }
    const request: InFlightManifestRead = { artifactId, requestId: this.#nextRequestId };
    this.#nextRequestId += 1;
    const generation = this.#host.scheduledReadGeneration();
    this.#holdManifestRead(request);
    try {
      const answer = await readGrowthAnswer("The manifest re-read", () =>
        this.#bridge.growth.artifactRead({ artifactId }),
      );
      // BOTH QUESTIONS, AND THEY ARE DIFFERENT ONES. The register answers "is this
      // reply still the one this row is waiting for" — the disposal case, and the case
      // a successor would create — and the stamp answers "has a refresh since re-read
      // the row this was about". Either alone leaves the other's late answer writable.
      if (!this.#stillStandingForManifestRead(request)) {
        return { status: "superseded" };
      }
      if (generation !== this.#host.scheduledReadGeneration()) {
        return { status: "superseded" };
      }
      if (answer.status === "refused") {
        return this.#recordRowRefusal(artifactId, answer.refusal);
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
    } finally {
      this.#releaseManifestRead(request);
    }
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
  public async fetchPayload(artifactId: string): Promise<ArtifactPayloadOutcome> {
    const pending = this.#inFlightFetch;
    if (pending !== undefined) {
      const refusal = payloadFetchInFlightRefusal(pending.artifactId);
      // Recorded against the ROW rather than on the payload arm, which the pending
      // fetch owns: writing the refusal there would take the pane off the in-flight
      // absence it is still genuinely in, and the answer it is waiting for would then
      // land on top of the refusal a moment later.
      this.#recordRowRefusal(artifactId, refusal);
      return { status: "refused", refusal };
    }
    const request: InFlightPayloadFetch = { artifactId, requestId: this.#nextRequestId };
    this.#nextRequestId += 1;
    this.#inFlightFetch = request;
    this.#host.publish({
      ...this.#host.currentReading(),
      payload: { status: "fetching", artifactId },
    });
    try {
      return await this.#awaitPayload(request);
    } finally {
      this.#release(request);
    }
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
   *
   * AND IT SUPERSEDES THE FETCH FOR THE SAME ARTIFACT, WHICH THE PUBLISH ALONE DOES
   * NOT. Clearing the payload arm takes the preview off the screen; it does not stop
   * the answer that is still on the wire. A read the daemon completed BEFORE the
   * delete can be delivered after it, and that continuation passed
   * `#stillStandingFor` — the register was untouched — so it republished the
   * destroyed manifest's bytes, and the reconciling list read carries a payload arm
   * forward rather than clearing it. Dropping the register is what makes the late
   * settlement `superseded`; it also gives the control back at the same moment the
   * screen says nothing is being fetched, which the untouched register contradicted.
   */
  public async deleteArtifact(artifactId: string): Promise<ArtifactDeleteOutcome> {
    const generation = this.#host.scheduledReadGeneration();
    const answer = await readGrowthAnswer("The delete", () =>
      this.#bridge.growth.artifactDelete({ artifactId }),
    );
    if (answer.status === "refused") {
      // A refusal records an act that did NOT happen, so a stamp that moved under it
      // means the row it was about has since been re-read and the refusal has nothing
      // left to stand beside.
      if (generation !== this.#host.scheduledReadGeneration()) {
        return { status: "superseded" };
      }
      this.#recordRowRefusal(artifactId, answer.refusal);
      return { status: "refused", refusal: answer.refusal };
    }
    if (this.#host.isDisposed()) {
      return { status: "superseded" };
    }
    const receipt = answer.value;
    // Before the publish, because the publish is what clears the visible payload and
    // the register is what would put it back.
    this.#supersedePayloadFetchFor(artifactId);
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

  /** Terminal. A call still on the wire settles into nothing rather than onto a pane that unmounted. */
  public dispose(): void {
    this.#inFlightFetch = undefined;
    this.#inFlightManifestReadByArtifactId.clear();
  }

  /** Take this row's register, and redraw so its re-read control holds. */
  #holdManifestRead(request: InFlightManifestRead): void {
    this.#inFlightManifestReadByArtifactId.set(request.artifactId, request);
    const reading = this.#host.currentReading();
    this.#host.publish({
      ...reading,
      manifestReadInFlightArtifactIds: withManifestReadInFlight(
        reading.manifestReadInFlightArtifactIds,
        request.artifactId,
      ),
    });
  }

  /**
   * Give this row's register back, but only where it is still this request's to give.
   *
   * A disposal clears the register out from under a continuation, and a request that no
   * longer holds it must not clear a successor's — the same identity check
   * `#stillStandingForManifestRead` makes before a settlement writes. The publish is
   * skipped on that arm too, because releasing a control this request no longer holds
   * would offer it while its successor's call is still on the wire.
   */
  #releaseManifestRead(request: InFlightManifestRead): void {
    const held = this.#inFlightManifestReadByArtifactId.get(request.artifactId);
    if (held?.requestId !== request.requestId) {
      return;
    }
    this.#inFlightManifestReadByArtifactId.delete(request.artifactId);
    if (this.#host.isDisposed()) {
      return;
    }
    const reading = this.#host.currentReading();
    this.#host.publish({
      ...reading,
      manifestReadInFlightArtifactIds: withoutManifestReadInFlight(
        reading.manifestReadInFlightArtifactIds,
        request.artifactId,
      ),
    });
  }

  /** Whether a settled re-read still speaks for the request this row's register holds. */
  #stillStandingForManifestRead(request: InFlightManifestRead): boolean {
    return (
      !this.#host.isDisposed() &&
      this.#inFlightManifestReadByArtifactId.get(request.artifactId)?.requestId ===
        request.requestId
    );
  }

  /** The call, and what its answer writes if this request still holds the register. */
  async #awaitPayload(request: InFlightPayloadFetch): Promise<ArtifactPayloadOutcome> {
    const { artifactId } = request;
    const answer = await readGrowthAnswer("The payload fetch", () =>
      this.#bridge.growth.artifactRead({ artifactId, includePayload: true }),
    );
    if (!this.#stillStandingFor(request)) {
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
   * `#stillStandingFor` makes before a settlement writes.
   */
  #release(request: InFlightPayloadFetch): void {
    if (this.#inFlightFetch?.requestId === request.requestId) {
      this.#inFlightFetch = undefined;
    }
  }

  /**
   * Give up the register where the fetch it holds is for an artifact that is gone.
   *
   * KEYED ON THE REGISTER AND NOT ON THE READING, because the register is what a
   * continuation is checked against: the reading names the pending artifact too, but
   * a settlement asks `#stillStandingFor`, so clearing the arm without clearing the
   * register leaves the answer admissible. Scoped to the matching artifact — a fetch
   * for a DIFFERENT one is unaffected by this delete and its answer is still wanted.
   *
   * The awaiting call still runs its `finally`; `#release` is identity-checked, so it
   * finds the register already given up and leaves any successor alone.
   */
  #supersedePayloadFetchFor(artifactId: string): void {
    if (this.#inFlightFetch?.artifactId === artifactId) {
      this.#inFlightFetch = undefined;
    }
  }

  /** Whether a settled call still speaks for the fetch the register is holding. */
  #stillStandingFor(request: InFlightPayloadFetch): boolean {
    return !this.#host.isDisposed() && this.#inFlightFetch?.requestId === request.requestId;
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
