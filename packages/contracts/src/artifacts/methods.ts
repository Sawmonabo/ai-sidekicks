// The `artifact.*` descriptor table. A client reads the list again on `artifact.published`, never
// on a timer. A file reaches a session's artifacts through the three ingest calls: open a stream,
// send its bytes in numbered chunks, and complete it. Any other kind of artifact a client holds
// whole is published in one call.
import { defineMethodDescriptors, type MethodDescriptor } from "../method-descriptor.js";

import {
  AttachmentIngestChunkRequestSchema,
  AttachmentIngestChunkResponseSchema,
  AttachmentIngestCompleteRequestSchema,
  AttachmentIngestCompleteResponseSchema,
  AttachmentIngestInitRequestSchema,
  AttachmentIngestInitResponseSchema,
  type AttachmentIngestChunkRequest,
  type AttachmentIngestChunkResponse,
  type AttachmentIngestCompleteRequest,
  type AttachmentIngestCompleteResponse,
  type AttachmentIngestInitRequest,
  type AttachmentIngestInitResponse,
} from "./ingest.js";
import {
  ArtifactListRequestSchema,
  ArtifactListResponseSchema,
  ArtifactReadRequestSchema,
  ArtifactReadResponseSchema,
  type ArtifactListRequest,
  type ArtifactListResponse,
  type ArtifactReadRequest,
  type ArtifactReadResponse,
} from "./operations.js";
import {
  ArtifactPublishRequestSchema,
  ArtifactPublishResponseSchema,
  type ArtifactPublishRequest,
  type ArtifactPublishResponse,
} from "./publication.js";

/** The `artifact.*` methods, keyed by method name. */
export interface ArtifactMethodDescriptors {
  readonly "artifact.list": MethodDescriptor<
    "artifact.list",
    ArtifactListRequest,
    ArtifactListResponse
  >;
  readonly "artifact.read": MethodDescriptor<
    "artifact.read",
    ArtifactReadRequest,
    ArtifactReadResponse
  >;
  readonly "artifact.ingestInit": MethodDescriptor<
    "artifact.ingestInit",
    AttachmentIngestInitRequest,
    AttachmentIngestInitResponse
  >;
  readonly "artifact.ingestChunk": MethodDescriptor<
    "artifact.ingestChunk",
    AttachmentIngestChunkRequest,
    AttachmentIngestChunkResponse
  >;
  readonly "artifact.ingestComplete": MethodDescriptor<
    "artifact.ingestComplete",
    AttachmentIngestCompleteRequest,
    AttachmentIngestCompleteResponse
  >;
  readonly "artifact.publish": MethodDescriptor<
    "artifact.publish",
    ArtifactPublishRequest,
    ArtifactPublishResponse
  >;
}

/** The `artifact.*` methods, each with its schemas. */
export const ARTIFACT_METHOD_DESCRIPTORS: ArtifactMethodDescriptors = defineMethodDescriptors({
  "artifact.list": {
    method: "artifact.list",
    procedureType: "query",
    mutating: false,
    requestSchema: ArtifactListRequestSchema,
    responseSchema: ArtifactListResponseSchema,
  },
  "artifact.read": {
    method: "artifact.read",
    procedureType: "query",
    mutating: false,
    requestSchema: ArtifactReadRequestSchema,
    responseSchema: ArtifactReadResponseSchema,
  },
  "artifact.ingestInit": {
    method: "artifact.ingestInit",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AttachmentIngestInitRequestSchema,
    responseSchema: AttachmentIngestInitResponseSchema,
  },
  "artifact.ingestChunk": {
    method: "artifact.ingestChunk",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AttachmentIngestChunkRequestSchema,
    responseSchema: AttachmentIngestChunkResponseSchema,
  },
  "artifact.ingestComplete": {
    method: "artifact.ingestComplete",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AttachmentIngestCompleteRequestSchema,
    responseSchema: AttachmentIngestCompleteResponseSchema,
  },
  "artifact.publish": {
    method: "artifact.publish",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ArtifactPublishRequestSchema,
    responseSchema: ArtifactPublishResponseSchema,
  },
});
