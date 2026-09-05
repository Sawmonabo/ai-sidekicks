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
  artifactIngestBegin: {
    request: { readonly sessionId: string; readonly name: string; readonly byteLength: number };
    value: { readonly ingestId: string };
  };
  artifactIngestWriteChunk: {
    request: { readonly ingestId: string; readonly offset: number; readonly byteLength: number };
    value: void;
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
