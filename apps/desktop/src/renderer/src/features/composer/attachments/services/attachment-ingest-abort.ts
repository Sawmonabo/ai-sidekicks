// Giving a spool back: the one call that is not part of the upload.
//
// SPLIT FROM `attachment-ingest-machine.ts` ON THE SEAM THE TWO ACTUALLY HAVE. The
// client owns what is SENT while a stream is still going: three legs, a ledger offset,
// a refusal a card renders, and a continuation that re-reads after every await. This
// module owns what is ASKED BACK once a stream has stopped, and every rule here is the
// opposite of the ones next door: the call is fire-and-forget rather than awaited, and
// its answer reaches no entry and no card.
//
// CANCEL IS ABANDONMENT, AND THE COPY SAYS SO. There is no cancel call in the ingest
// trio. A user who stops an upload stops SENDING; the daemon's abandoned-spool reaper
// claims the bytes afterwards. The abort is asked for best-effort and the caller states
// the honest outcome either way.

import type { AttachmentIngestPort } from "./attachment-ingest-answer.js";

/** The abort leg. */
export class AttachmentSpoolReclaimer {
  readonly #port: Pick<AttachmentIngestPort, "abort">;

  public constructor(port: Pick<AttachmentIngestPort, "abort">) {
    this.#port = port;
  }

  /**
   * Ask for a spool back, best-effort, for a stream the daemon actually opened.
   *
   * FIRED AND NOT AWAITED, because every caller is synchronous and terminal: a staged list
   * that waited on a best-effort abort would hold a closed surface open for an answer
   * nobody is left to render. Nothing catches it, so a rejection surfaces as the page's
   * unhandled rejection.
   *
   * An absent ingest id is a stream the daemon never opened, so there is nothing to
   * ask back and the absence is handled here rather than at four call sites.
   */
  public request(ingestId: string | undefined): void {
    if (ingestId === undefined) {
      return;
    }
    void this.#port.abort({ ingestId });
  }
}
