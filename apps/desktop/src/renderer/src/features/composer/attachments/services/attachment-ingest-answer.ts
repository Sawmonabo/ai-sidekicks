// The ingest port a client is handed, and what each of its calls answers.
//
// A MODULE OF ITS OWN BECAUSE IT IS A SEAM AND NOT A DETAIL. The protocol
// (`attachment-ingest-stream.ts`, `attachment-ingest-chunks.ts`) and the reclaim
// (`attachment-ingest-abort.ts`) each call the port, so its shape is declared once
// here. Declaring it here also keeps the dependency one-way: the client imports the
// reclaim, the reclaim imports nothing of the client's.
//
// A CALL ANSWERS ITS VALUE AND A REJECTION PROPAGATES. Nothing in this client turns a
// port rejection into state. A rejected `begin`, `writeChunk` or `complete` rejects the
// promise of `drive`, which `attach` and `retry` discard, so it reaches the page as an
// unhandled rejection; a rejected `abort` does too, because nobody awaits it.

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
