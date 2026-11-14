// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `artifact.*` methods. A client reads the list again on `artifact.published`, never on a timer.

import type { SchemaCheck } from "../../schema-check.js";
import {
  validateArtifactIngestCompleteRequest,
  validateArtifactIngestCompleteResponse,
  validateArtifactIngestStartRequest,
  validateArtifactIngestStartResponse,
  validateArtifactIngestWriteRequest,
  validateArtifactIngestWriteResponse,
} from "../checks/artifacts/ingest.js";
import {
  validateArtifactListRequest,
  validateArtifactListResponse,
  validateArtifactReadRequest,
  validateArtifactReadResponse,
} from "../checks/artifacts/operations.js";
import {
  validateArtifactPublishRequest,
  validateArtifactPublishResponse,
} from "../checks/artifacts/publication.js";
import type {
  ArtifactIngestCompleteRequest,
  ArtifactIngestCompleteResponse,
  ArtifactIngestStartRequest,
  ArtifactIngestStartResponse,
  ArtifactIngestWriteRequest,
  ArtifactIngestWriteResponse,
} from "./ingest.js";
import type {
  ArtifactListRequest,
  ArtifactListResponse,
  ArtifactReadRequest,
  ArtifactReadResponse,
} from "./operations.js";
import type { ArtifactPublishRequest, ArtifactPublishResponse } from "./publication.js";

/** The methods of {@link ARTIFACT_METHOD_DESCRIPTORS}, each with its checks. */
export interface ArtifactMethodDescriptors {
  readonly "artifact.list": {
    readonly method: "artifact.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ArtifactListRequest>;
    readonly responseCheck: SchemaCheck<ArtifactListResponse>;
  };
  readonly "artifact.read": {
    readonly method: "artifact.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ArtifactReadRequest>;
    readonly responseCheck: SchemaCheck<ArtifactReadResponse>;
  };
  readonly "artifact.ingest.start": {
    readonly method: "artifact.ingest.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ArtifactIngestStartRequest>;
    readonly responseCheck: SchemaCheck<ArtifactIngestStartResponse>;
  };
  readonly "artifact.ingest.write": {
    readonly method: "artifact.ingest.write";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ArtifactIngestWriteRequest>;
    readonly responseCheck: SchemaCheck<ArtifactIngestWriteResponse>;
  };
  readonly "artifact.ingest.complete": {
    readonly method: "artifact.ingest.complete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ArtifactIngestCompleteRequest>;
    readonly responseCheck: SchemaCheck<ArtifactIngestCompleteResponse>;
  };
  readonly "artifact.publish": {
    readonly method: "artifact.publish";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ArtifactPublishRequest>;
    readonly responseCheck: SchemaCheck<ArtifactPublishResponse>;
  };
}
/** The `artifact.*` methods, each with its checks. */
export const ARTIFACT_METHOD_DESCRIPTORS: ArtifactMethodDescriptors = /* @__PURE__ */ Object.freeze(
  {
    "artifact.list": /* @__PURE__ */ Object.freeze({
      method: "artifact.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateArtifactListRequest,
      responseCheck: validateArtifactListResponse,
    }),
    "artifact.read": /* @__PURE__ */ Object.freeze({
      method: "artifact.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateArtifactReadRequest,
      responseCheck: validateArtifactReadResponse,
    }),
    "artifact.ingest.start": /* @__PURE__ */ Object.freeze({
      method: "artifact.ingest.start",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateArtifactIngestStartRequest,
      responseCheck: validateArtifactIngestStartResponse,
    }),
    "artifact.ingest.write": /* @__PURE__ */ Object.freeze({
      method: "artifact.ingest.write",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateArtifactIngestWriteRequest,
      responseCheck: validateArtifactIngestWriteResponse,
    }),
    "artifact.ingest.complete": /* @__PURE__ */ Object.freeze({
      method: "artifact.ingest.complete",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateArtifactIngestCompleteRequest,
      responseCheck: validateArtifactIngestCompleteResponse,
    }),
    "artifact.publish": /* @__PURE__ */ Object.freeze({
      method: "artifact.publish",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateArtifactPublishRequest,
      responseCheck: validateArtifactPublishResponse,
    }),
  },
);
