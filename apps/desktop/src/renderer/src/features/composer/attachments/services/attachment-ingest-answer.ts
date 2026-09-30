// The ingest port a client is handed, declared once because the stream, the chunk loop and the
// reclaimer all call through it. A port rejection is never turned into state: it rejects the
// promise of `drive`, which `attach` and `retry` discard, so it reaches the page as an
// unhandled rejection, and so does a rejected `abort`.

import type {
  AttachmentIngestChunkRequest,
  AttachmentIngestCompleteRequest,
  AttachmentIngestInitRequest,
  SessionAttachmentSummary,
} from "@ai-sidekicks/contracts";

/**
 * The four calls of one upload. The three the daemon registers take its own request
 * shapes; `mediaType` is absent, not empty, when none was declared. `complete` answers
 * what the daemon derived from the bytes it spooled.
 */
export interface AttachmentIngestPort {
  readonly begin: (request: AttachmentIngestInitRequest) => Promise<{ readonly ingestId: string }>;
  readonly writeChunk: (
    request: AttachmentIngestChunkRequest,
  ) => Promise<{ readonly ingestId: string; readonly receivedBytes: number }>;
  readonly complete: (
    request: AttachmentIngestCompleteRequest,
  ) => Promise<SessionAttachmentSummary>;
  readonly abort: (request: { readonly ingestId: string }) => Promise<void>;
}
