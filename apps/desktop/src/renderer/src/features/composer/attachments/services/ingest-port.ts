// The ingest port a client is handed, declared once because the stream driver and the chunk loop
// both call through it. A rejected call becomes the entry's refusal in the stream driver.

import type {
  AttachmentIngestChunkRequest,
  AttachmentIngestChunkResponse,
  AttachmentIngestCompleteRequest,
  AttachmentIngestCompleteResponse,
  AttachmentIngestInitRequest,
  AttachmentIngestInitResponse,
} from "@ai-sidekicks/contracts/artifacts/ingest";

/**
 * The three calls of one upload, in the daemon's own request and response shapes; `mediaType` is
 * absent, not empty, when none was declared. `complete` answers what the daemon derived from the
 * bytes it spooled.
 */
export interface AttachmentIngestPort {
  readonly begin: (request: AttachmentIngestInitRequest) => Promise<AttachmentIngestInitResponse>;
  readonly writeChunk: (
    request: AttachmentIngestChunkRequest,
  ) => Promise<AttachmentIngestChunkResponse>;
  readonly complete: (
    request: AttachmentIngestCompleteRequest,
  ) => Promise<AttachmentIngestCompleteResponse>;
}
