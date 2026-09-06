// The artifact plane: the three-call ingest, the manifest and payload reads, the
// delete receipt, and the allowlist a surface checks before it offers any of them.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. The row
// comments below are the file's own, kept with the rows they explain.

import type {
  GrowthArtifactDeleteReceipt,
  GrowthArtifactRead,
  GrowthArtifactSummary,
  GrowthAttachmentIngestCompletion,
} from "../growth-values/index.js";

export interface ArtifactGrowthSignatures {
  // The four members `AttachmentIngestInitRequest` registers that this caller can fill,
  // spelled the way it spells them — the same rule the chunk row below follows, and the
  // reason `fileName` and `declaredSizeBytes` are not the shorter names a console would
  // pick for itself. `mediaType` is ADVISORY and OPTIONAL, a hint that narrows the
  // expected signature and never widens acceptance, and one consequence of its ABSENCE is
  // normative: an undetermined-signature payload carrying no declaration has nothing to
  // admit it under the signature-exempt branch and is refused. A leading-byte signature
  // determines nothing for `application/json` or `text/markdown`, so an ordinary text
  // attachment is exactly the case that needs the declaration forwarded. Absent is a
  // first-class state, so the member is OMITTED when the participant's file declared
  // nothing — never sent as an empty string, which would be a declaration of nothing
  // rather than the absence the contract names.
  //
  // The registered `runId?` is deliberately not here: this client fills a composer's
  // carrier, which has no run to name, so the member would be a request field with no
  // caller — minted ahead of its reader.
  artifactIngestBegin: {
    request: {
      readonly sessionId: string;
      readonly fileName: string;
      readonly mediaType?: string;
      readonly declaredSizeBytes: number;
    };
    value: { readonly ingestId: string };
  };
  // The three members `AttachmentIngestChunkRequest` registers, spelled the way it
  // spells them. `sequenceNumber` is 0-based and strictly consecutive, and `chunk` is
  // the RFC 4648 §4 base64 of at most one chunk cap of RAW bytes — the wire is JSON
  // with no binary serialization, so a payload byte reaches the daemon encoded or it
  // does not reach it at all. An offset is not among them: the daemon appends in
  // sequence order and keeps the spooled count itself.
  //
  // AND IT ANSWERS THAT COUNT, WHICH IS WHY THIS IS NOT `void`.
  // `api-payload-contracts.md §Plan-014 — Artifacts Files And Attachments` registers
  // `AttachmentIngestChunkResponse` as `{ ingestId, receivedBytes }`, the second being
  // the spooled running total of DECODED bytes after this chunk and the very bound the
  // daemon enforces. Declared `void`, a contract-shaped implementation could not
  // satisfy this port without a cast, and the caller could not say which stream had
  // been acknowledged or how far it had got — so the client charted what it had SENT
  // instead, which is a different number the moment anything is dropped or replayed.
  artifactIngestWriteChunk: {
    request: {
      readonly ingestId: string;
      readonly sequenceNumber: number;
      readonly chunk: string;
    };
    value: { readonly ingestId: string; readonly receivedBytes: number };
  };
  artifactIngestComplete: {
    request: { readonly ingestId: string };
    value: GrowthAttachmentIngestCompletion;
  };
  artifactList: {
    request: { readonly sessionId: string };
    value: readonly GrowthArtifactSummary[];
  };
  // The read is TWO reads behind one method, told apart by `includePayload`: the
  // pane's manifest read leaves it absent and gets the envelope, and its payload
  // fetch sets it and gets the bytes beside the envelope. The member is the wire's
  // own discriminator rather than a console convenience — without it here the
  // second read had no request to make and no member to receive an answer on, so
  // the pane could render an artifact's metadata and never its content.
  artifactRead: {
    request: { readonly artifactId: string; readonly includePayload?: boolean };
    value: GrowthArtifactRead;
  };
  // The receipt, not `void`. A delete settles two facts nothing can recover afterwards
  // — where the payload's bytes went, and whether destroying the retained relay key has
  // foreclosed re-publish — and a `void` reply left a surface able to say only that the
  // call returned.
  artifactDelete: {
    request: { readonly artifactId: string };
    value: GrowthArtifactDeleteReceipt;
  };
  artifactAllowlistRead: {
    request: { readonly sessionId: string };
    value: { readonly contentTypes: readonly string[]; readonly maximumByteLength: number };
  };
  artifactIngestAbort: { request: { readonly ingestId: string }; value: void };
}
