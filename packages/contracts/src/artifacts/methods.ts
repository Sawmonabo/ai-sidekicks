// The `artifact.*` descriptor table: each method's name, procedure type, whether it changes
// state, and the schemas the registry validates its request and its result against. The list
// is read again on `artifact.published` rather than on a timer. A descriptor registers nothing.
import { defineMethodDescriptors, type MethodDescriptor } from "../method-descriptor.js";

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
});
