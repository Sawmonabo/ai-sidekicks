// Giving a spool back: the one call that is not part of the upload. There is no cancel call in
// the ingest trio, so stopping an upload only stops sending and the daemon's abandoned-spool
// reaper claims the bytes later. The abort is best-effort and fire-and-forget: its answer reaches
// no entry and no card, and a refused abort goes to the window's diagnostic capture.

import { type Clock } from "@renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";
import { wireRejectionToError } from "@renderer/lib/wire-errors.js";
import type { AttachmentIngestPort } from "./attachment-ingest-answer.js";

/** Asks the daemon, best-effort, to give back the spool of a stopped stream. */
export class AttachmentSpoolReclaimer {
  readonly #port: Pick<AttachmentIngestPort, "abort">;
  readonly #clock: Clock;

  /** `clock` stamps the diagnostic record a refused abort leaves. */
  public constructor(port: Pick<AttachmentIngestPort, "abort">, clock: Clock) {
    this.#port = port;
    this.#clock = clock;
  }

  /**
   * Ask for a spool back for a stream the daemon actually opened; an absent ingest id means
   * it never did, so there is nothing to ask. Fired and not awaited, because every caller is
   * synchronous and terminal.
   */
  public request(ingestId: string | undefined): void {
    if (ingestId === undefined) {
      return;
    }
    this.#port.abort({ ingestId }).catch((rejection: unknown) => {
      windowDiagnosticCapture.record({
        at: diagnosticStampAt(this.#clock),
        severity: "warning",
        source: "features/composer",
        kind: "attachment-spool-abort-refused",
        detail: `ingest ${ingestId}: ${wireRejectionToError(rejection).message}`,
      });
    });
  }
}
