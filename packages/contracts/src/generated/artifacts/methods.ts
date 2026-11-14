// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `artifact.*` methods. A client reads the list again on `artifact.published`, never on a timer.

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

/** The methods of {@link ARTIFACT_METHOD_DESCRIPTORS}, each with its kind. */
export interface ArtifactMethodDescriptors {
  readonly "artifact.list": {
    readonly method: "artifact.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "artifact.read": {
    readonly method: "artifact.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "artifact.ingest.start": {
    readonly method: "artifact.ingest.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "artifact.ingest.write": {
    readonly method: "artifact.ingest.write";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "artifact.ingest.complete": {
    readonly method: "artifact.ingest.complete";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "artifact.publish": {
    readonly method: "artifact.publish";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link ARTIFACT_METHOD_DESCRIPTORS}. */
export interface ArtifactMethodTypes {
  readonly "artifact.list": {
    readonly params: ArtifactListRequest;
    readonly result: ArtifactListResponse;
  };
  readonly "artifact.read": {
    readonly params: ArtifactReadRequest;
    readonly result: ArtifactReadResponse;
  };
  readonly "artifact.ingest.start": {
    readonly params: ArtifactIngestStartRequest;
    readonly result: ArtifactIngestStartResponse;
  };
  readonly "artifact.ingest.write": {
    readonly params: ArtifactIngestWriteRequest;
    readonly result: ArtifactIngestWriteResponse;
  };
  readonly "artifact.ingest.complete": {
    readonly params: ArtifactIngestCompleteRequest;
    readonly result: ArtifactIngestCompleteResponse;
  };
  readonly "artifact.publish": {
    readonly params: ArtifactPublishRequest;
    readonly result: ArtifactPublishResponse;
  };
}
/** The `artifact.*` methods, each with its checks. */
export const ARTIFACT_METHOD_DESCRIPTORS: ArtifactMethodDescriptors = /* @__PURE__ */ Object.freeze(
  {
    "artifact.list": /* @__PURE__ */ Object.freeze({
      method: "artifact.list",
      procedureType: "query",
      mutating: false,
    }),
    "artifact.read": /* @__PURE__ */ Object.freeze({
      method: "artifact.read",
      procedureType: "query",
      mutating: false,
    }),
    "artifact.ingest.start": /* @__PURE__ */ Object.freeze({
      method: "artifact.ingest.start",
      procedureType: "mutation",
      mutating: true,
    }),
    "artifact.ingest.write": /* @__PURE__ */ Object.freeze({
      method: "artifact.ingest.write",
      procedureType: "mutation",
      mutating: true,
    }),
    "artifact.ingest.complete": /* @__PURE__ */ Object.freeze({
      method: "artifact.ingest.complete",
      procedureType: "mutation",
      mutating: true,
    }),
    "artifact.publish": /* @__PURE__ */ Object.freeze({
      method: "artifact.publish",
      procedureType: "mutation",
      mutating: true,
    }),
  },
);
