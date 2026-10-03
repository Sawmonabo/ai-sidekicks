// The ingest port a client is handed, declared once because the stream, the chunk loop and the
// reclaimer all call through it. A rejected `begin`, `writeChunk` or `complete` becomes the
// entry's refusal in the stream driver; a rejected `abort` goes to the window's diagnostic
// capture.

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
