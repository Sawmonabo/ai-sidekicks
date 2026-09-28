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

/** What the daemon derived from a completed upload; the client reads these four. */
export interface AttachmentIngestCompletion {
  readonly artifactId: string;
  readonly normalizedName: string;
  readonly derivedMediaType: string;
  readonly derivedSizeBytes: number;
}

/** The four calls of one upload; `mediaType` is absent, not empty, when none was declared. */
export interface AttachmentIngestPort {
  readonly begin: (request: {
    readonly sessionId: string;
    readonly fileName: string;
    readonly mediaType?: string;
    readonly declaredSizeBytes: number;
  }) => Promise<{ readonly ingestId: string }>;
  readonly writeChunk: (request: {
    readonly ingestId: string;
    readonly sequenceNumber: number;
    readonly chunk: string;
  }) => Promise<{ readonly ingestId: string; readonly receivedBytes: number }>;
  readonly complete: (request: {
    readonly ingestId: string;
  }) => Promise<AttachmentIngestCompletion>;
  readonly abort: (request: { readonly ingestId: string }) => Promise<void>;
}
