// Giving a spool back: the one call that is not part of the upload, and the one
// answer nobody renders.
//
// SPLIT FROM `attachment-ingest-machine.ts` ON THE SEAM THE TWO ACTUALLY HAVE. The
// machine owns what is SENT while a stream is still going — three legs, a ledger
// offset, a refusal a card renders, and a continuation that re-reads after every
// await. This module owns what is ASKED BACK once a stream has stopped, and every
// rule here is the opposite of the ones next door: the call is fire-and-forget rather
// than awaited, its answer reaches no entry and no card, and a refusal of it is a
// diagnostic rather than a state. Together in one file those two sets of rules read
// as exceptions to each other; apart, each is one subject with one lifetime.
//
// CANCEL IS ABANDONMENT, AND THE COPY SAYS SO. There is no cancel call in the ingest
// trio. A participant who stops an upload stops SENDING; the daemon's abandoned-spool
// reaper claims the bytes afterwards. `artifactIngestAbort` is the first-class version
// and is its own slate row (`artifact-allowlist-and-abort`), so this asks for it
// best-effort and the caller states the honest outcome either way.
//
// AND A REJECTED ABORT IS NOT AN UNREAD ONE EITHER. The call can fail without
// answering — an IPC disconnect takes the bridge namespace with it — and that is
// exactly the path on which the spool matters most: the daemon may never have heard
// the request, so the bytes and their reservation stand until the reaper with nothing
// anywhere saying so. Fired and not awaited, a rejection here reached no `catch` at
// all, so it became an unhandled rejection in the page and skipped the one diagnostic
// this module exists to write. It is caught and normalized through the repos family's
// own `repoCallRefusal` — the same normalizer the protocol's legs use, so a
// rejection carrying a daemon code keeps it — and then reported down the same path as
// a refused answer, because to the spool the two mean one thing: nobody released it.
//
// BEST-EFFORT IS NOT UNREAD. Every caller is terminal for its entry — abandonment has
// already moved it, disposal is taking the whole ledger — so there is no entry to
// write a refusal onto and no surface left to render one. That is exactly why the
// answer goes to the console's diagnostic band instead: a daemon that declined to
// release a spool is holding bytes and an aggregate reservation until its reaper, and
// an operator whose next upload fails capacity admission has otherwise nothing to
// read. `core/tripwires.ts` names that kind `cleanup-refused`, and this module is its
// one firing site.

import type { ConsoleBridge } from "../../bridge/index.js";
import { reportTripwire } from "../../core/index.js";
import type { PortAnswer } from "./attachment-ingest-answer.js";
import { repoCallRefusal } from "../repo-reads.js";

/** Where the unreclaimed-spool tripwire reports from, so a firing names a module. */
export const INGEST_ABORT_SITE = "console/repos/attachments/attachment-ingest-abort.ts";

/** What this leg is called in the sentence a rejection is rendered into. */
const INGEST_ABORT_LEG = "The spool reclaim";

/**
 * The one refusal code that means the abort was never put to a daemon.
 *
 * Named rather than spelled at the branch, because `bridge/growth-outcome.ts` owns the
 * word and a literal here would be a second spelling of a closed set — the failure the
 * console's vocabularies are all declared once to avoid.
 */
const INGEST_ABORT_UNASKED_CODE = "wire-unregistered";

/** The abort leg, and the diagnostic band a refused one reaches. */
export class AttachmentSpoolReclaimer {
  readonly #bridge: ConsoleBridge;

  public constructor(bridge: ConsoleBridge) {
    this.#bridge = bridge;
  }

  /**
   * Ask for a spool back, best-effort, for a stream the daemon actually opened.
   *
   * FIRED AND NOT AWAITED, because every caller is synchronous and terminal: a carrier
   * that waited on a best-effort abort would hold a closed surface open for an answer
   * nobody is left to render. What the continuation does with that answer is
   * `#recordUnreclaimedSpool`'s job.
   *
   * An absent ingest id is a stream the daemon never opened, so there is nothing to
   * ask back and the absence is handled here rather than at four call sites.
   */
  public request(ingestId: string | undefined): void {
    if (ingestId === undefined) {
      return;
    }
    void this.#requestAbort(ingestId);
  }

  /**
   * Send the abort and dispose of its answer, which is a fact whichever way it goes.
   *
   * The `catch` is what makes "whichever way" true: `request` discards this promise, so
   * a rejection escaping here is an unhandled rejection AND a spool nobody recorded.
   * Normalized into the same unavailable answer a refusal arrives as, it reaches the
   * one report below by the one path — and a rejection that carried a daemon code is
   * still reported under that code rather than under a console-side stand-in.
   */
  async #requestAbort(ingestId: string): Promise<void> {
    let answer: PortAnswer<void>;
    try {
      answer = await this.#bridge.growth.artifactIngestAbort({ ingestId });
    } catch (rejection) {
      const refusal = repoCallRefusal(INGEST_ABORT_LEG, rejection);
      answer = { status: "unavailable", code: refusal.code, detail: refusal.detail };
    }
    if (answer.status === "served") {
      return;
    }
    this.#recordUnreclaimedSpool(ingestId, answer);
  }

  /**
   * Say that a spool this client asked back is still the daemon's to reclaim.
   *
   * THE `wire-unregistered` ARM IS NOT A REFUSED CLEANUP AND IS NOT REPORTED AS ONE.
   * That code means the console's own port declined before any request left this
   * process, so no daemon was asked and none refused — the same `not-checked` against
   * `refused` distinction every surface in this console draws, applied to a call whose
   * answer nobody renders. Recording it would put a firing on the diagnostic band for
   * V1's designed absence, and the abandonment copy already tells a participant what
   * happens to those bytes: the reaper claims them.
   *
   * EVERY OTHER CODE IS A DAEMON THAT ANSWERED AND DID NOT RELEASE. The spool and the
   * bytes reserved for it stand until that reaper runs, a later upload in the same
   * session can fail capacity admission because of them, and the entry this abort
   * belonged to is gone — so the tripwire record is the only place it can be seen.
   */
  #recordUnreclaimedSpool(ingestId: string, answer: PortAnswer<unknown>): void {
    if (answer.code === INGEST_ABORT_UNASKED_CODE) {
      return;
    }
    reportTripwire(
      "cleanup-refused",
      INGEST_ABORT_SITE,
      `the daemon answered the abort of ingest ${ingestId} with \`${answer.code ?? "no code at all"}\` and did not release it; its spool and the bytes reserved for it stand until the abandoned-spool reaper claims them`,
    );
  }
}
