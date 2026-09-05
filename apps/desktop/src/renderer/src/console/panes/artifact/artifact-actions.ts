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
//     one artifact's bytes under another's name. That register and that rule are
//     `artifact-payload-fetch.ts`: a class of its own because it is the one act here
//     whose concurrency is decided by neither the row nor the refresh, and this class
//     publishes its `fetchPayload` so a row still presses one object for all three.
//
// THE FETCH'S OWN REASONING TRAVELLED WITH IT, and only the part the delete depends
// on is restated here. Why the fetch has an identity of its own and no longer reads
// the refresh stamp:
// Both questions used to be answered by the reader's one read round, and that conflated
// two facts that move independently. A list refresh landing under a fetch bumped the
// stamp, so the fetch returned `superseded` and published nothing — leaving the
// reading on `{ status: "fetching" }` with no answer ever coming, which is precisely
// the state the held control below would have locked forever. A scheduled read does
// not supersede a payload fetch: `#performRead` carries the payload arm forward
// untouched, because a list read re-establishes which artifacts exist and answers
// nothing about anyone's bytes. So the fetch is settled by ITS OWN id, and disposal is
// asked separately.
//
// AND THE RE-READ HAS A ROUND OF ITS OWN, BECAUSE THE REFRESH STAMP IS NOT ONE.
// Two presses on one row before the first settles capture the SAME
// scheduled read round — starting an act does not supersede it, and it is the
// reader's to move — so both continuations passed the supersession check and whichever
// reply the bridge delivered LAST decided what the row says. Two reads of one manifest
// can settle in either order, so that is the older answer overwriting the newer one,
// silently, on a row the participant pressed twice precisely because they wanted the
// fresher reading. The round is therefore taken AT ISSUE from `store/generation-latch.
// ts`, KEYED BY ARTIFACT ID because two rows re-reading are two independent calls that
// cannot collide — and the reading names the rows whose reads are outstanding, which is
// what holds each one's control. A press that reached here anyway is refused in words.
//
// THE ROUND IS THE CONSOLE'S ONE REGISTER AND NEVER A COUNTER OF THIS FILE'S OWN.
// A hand-rolled table of request ids answered exactly the three questions
// `GenerationLatch` answers — may I dispatch, is this settlement still mine, give the
// key back — and the place copies of a guard drift is the predicate. `claim` refuses
// the second press rather than superseding it, which is this act's rule; `isCurrent`
// answers supersession and disposal in one question, because `dispose` supersedes
// every key; and `release` is guarded by the round's own serial, so a continuation
// that no longer holds the key cannot free its successor's.
//
// AND A CALL THAT REJECTS IS AN ANSWER, WHICH IS WHY NO ACT HERE AWAITS THE PORT
// BARE. The live bridge crosses a process boundary, so an IPC disconnect makes the
// call THROW rather than answer a refusal — and a thrown fetch never reached
// `growthAnswerReading` at all: the `finally` gave the register back while the
// reading stayed on `{ status: "fetching" }`, which is the arm the pane holds its
// control by and the arm a scheduled list read deliberately carries forward. The
// pane was then stuck until it was remounted. Every act goes through
// `readGrowthAnswer` (`growth-call.ts`), which reads a rejection as the refusal it is
// through the console's one rejection normalizer and the growth port's own
// vocabulary, so a disconnect lands on the same refused arm a typed wire refusal does,
// under the same subsystem name, and the control comes back. It is a
// module of its own because the READ half needs the same door, and a second copy
// would be two chances to relabel a code the console may not paraphrase.

import type { ConsoleBridge } from "../../bridge/index.js";
import { artifactManifestRowFromSummary } from "../../repos/artifacts/artifact-model.js";
import { GenerationLatch, type GenerationClaim } from "../../store/index.js";
import { recordRowRefusal, type ArtifactActionHost } from "./artifact-action-host.js";
import { ArtifactPayloadFetches } from "./artifact-payload-fetch.js";
import { readGrowthAnswer } from "./growth-call.js";
import {
  manifestReadInFlightRefusal,
  withManifestReadInFlight,
  withReplacedRow,
  withoutManifestReadInFlight,
  withoutRow,
  withoutRowRefusal,
  type ArtifactDeleteOutcome,
  type ArtifactRowActOutcome,
} from "./artifact-pane-reading.js";
import { type ArtifactPayloadOutcome } from "./artifact-payload.js";

export interface ArtifactPaneActionsOptions {
  readonly bridge: ConsoleBridge;
  readonly host: ArtifactActionHost;
}

/** The three acts a row offers, and what each answer writes onto the reading. */
export class ArtifactPaneActions {
  readonly #bridge: ConsoleBridge;
  readonly #host: ArtifactActionHost;
  /** The pane's payload fetch, single flight and register both. */
  readonly #payloadFetches: ArtifactPayloadFetches;
  /**
   * The manifest re-read awaiting the bridge on each row. One per row, and the reading
   * says which rows those are.
   *
   * KEYED BY ARTIFACT ID AND NEVER PER PANE: two rows re-reading are two calls about
   * two manifests that cannot collide, and a pane holding one row's control because
   * another row is waiting would hold it for a reason that is not about it. The latch
   * is keyed exactly that way, so the rule is the key rather than a mode.
   */
  readonly #manifestReads = new GenerationLatch();

  public constructor(options: ArtifactPaneActionsOptions) {
    this.#bridge = options.bridge;
    this.#host = options.host;
    this.#payloadFetches = new ArtifactPayloadFetches(options);
  }

  /**
   * Fetch one artifact's bytes.
   *
   * Delegated whole to `artifact-payload-fetch.ts`, which owns the register and the
   * rule: single flight across the pane by its own request identity, superseded by a
   * delete of the artifact it is about and by nothing else. It is published here so a
   * row presses one object for all three acts.
   */
  public async fetchPayload(artifactId: string): Promise<ArtifactPayloadOutcome> {
    return this.#payloadFetches.fetch(artifactId);
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
   * because neither of them moved it — see the header. So the press takes this row's
   * key at issue, the reading names the row while it is held, and a settlement whose
   * round the latch has moved past writes nothing.
   */
  public async readManifest(artifactId: string): Promise<ArtifactRowActOutcome> {
    const manifestRound = this.#manifestReads.claim(this, artifactId);
    if (manifestRound === undefined) {
      return recordRowRefusal(this.#host, artifactId, manifestReadInFlightRefusal(artifactId));
    }
    const readRound = this.#host.scheduledReadClaim();
    this.#holdManifestRead(artifactId);
    try {
      const answer = await readGrowthAnswer("The manifest re-read", () =>
        this.#bridge.growth.artifactRead({ artifactId }),
      );
      // BOTH QUESTIONS, AND THEY ARE DIFFERENT ONES. This row's round answers "is this
      // reply still the one this row is waiting for" — the disposal case, and the case
      // a successor would create — and the stamp answers "has a refresh since re-read
      // the row this was about". Either alone leaves the other's late answer writable.
      if (!manifestRound.isCurrent) {
        return { status: "superseded" };
      }
      if (!readRound.isCurrent) {
        return { status: "superseded" };
      }
      if (answer.status === "refused") {
        return recordRowRefusal(this.#host, artifactId, answer.refusal);
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
      this.#releaseManifestRead(artifactId, manifestRound);
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
    const readRound = this.#host.scheduledReadClaim();
    const answer = await readGrowthAnswer("The delete", () =>
      this.#bridge.growth.artifactDelete({ artifactId }),
    );
    if (answer.status === "refused") {
      // A refusal records an act that did NOT happen, so a round superseded under it
      // means the row it was about has since been re-read and the refusal has nothing
      // left to stand beside.
      if (!readRound.isCurrent) {
        return { status: "superseded" };
      }
      recordRowRefusal(this.#host, artifactId, answer.refusal);
      return { status: "refused", refusal: answer.refusal };
    }
    if (this.#host.isDisposed()) {
      return { status: "superseded" };
    }
    const receipt = answer.value;
    // Before the publish, because the publish is what clears the visible payload and
    // the register is what would put it back.
    this.#payloadFetches.supersedeFor(artifactId);
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
    return readRound.isCurrent
      ? { status: "settled", receipt }
      : { status: "reconciling", receipt };
  }

  /** Terminal. A call still on the wire settles into nothing rather than onto a pane that unmounted. */
  public dispose(): void {
    this.#payloadFetches.dispose();
    this.#manifestReads.supersedeAll();
  }

  /** Take this row's key, and redraw so its re-read control holds. */
  #holdManifestRead(artifactId: string): void {
    const reading = this.#host.currentReading();
    this.#host.publish({
      ...reading,
      manifestReadInFlightArtifactIds: withManifestReadInFlight(
        reading.manifestReadInFlightArtifactIds,
        artifactId,
      ),
    });
  }

  /**
   * Give this row's key back, but only where it is still this round's to give.
   *
   * `release` is guarded by the round's own serial, so a continuation the latch has
   * moved past — a disposal here, a successor once one is reachable — frees nothing.
   * The publish is asked separately and skipped on that arm, because offering a
   * control this round no longer holds would offer it while its successor's call is
   * still on the wire.
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
      manifestReadInFlightArtifactIds: withoutManifestReadInFlight(
        reading.manifestReadInFlightArtifactIds,
        artifactId,
      ),
    });
  }
}
