// Giving a spool back: the one call that is not part of the upload. There is no cancel call in
// the ingest trio, so stopping an upload only stops sending and the daemon's abandoned-spool
// reaper claims the bytes later. The abort is best-effort and fire-and-forget, and its answer
// reaches no entry and no card.

import type { AttachmentIngestPort } from "./attachment-ingest-answer.js";

/** Asks the daemon, best-effort, to give back the spool of a stopped stream. */
export class AttachmentSpoolReclaimer {
  readonly #port: Pick<AttachmentIngestPort, "abort">;

  public constructor(port: Pick<AttachmentIngestPort, "abort">) {
    this.#port = port;
  }

  /**
   * Ask for a spool back for a stream the daemon actually opened; an absent ingest id means
   * it never did, so there is nothing to ask. Fired and not awaited, because every caller is
   * synchronous and terminal; a rejection surfaces as the page's unhandled rejection.
   */
  public request(ingestId: string | undefined): void {
    if (ingestId === undefined) {
      return;
    }
    void this.#port.abort({ ingestId });
  }
}
