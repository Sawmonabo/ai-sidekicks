// The three calls that stream a caller's file into a session's artifacts: `artifact.ingestInit`
// opens a stream, `artifact.ingestChunk` appends one numbered chunk, and `artifact.ingestComplete`
// checks the spooled bytes and writes the file's manifest, attributed to the calling device.

import { ARTIFACT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/artifacts/methods";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";

import type { AttachmentIngestService } from "../../../artifacts/ingest/service.js";

import { callingDeviceOf } from "../../registry.js";
import { registerDescribedMethod } from "../register-described-method.js";

/**
 * Binds the three ingest calls onto the registry, answered by `ingest`. A completion with no
 * stamped device is a wiring fault and throws, since every artifact a request makes names its
 * device.
 */
export function registerArtifactIngestMethods(
  registry: MethodRegistry,
  ingest: AttachmentIngestService,
): void {
  registerDescribedMethod(
    registry,
    ARTIFACT_METHOD_DESCRIPTORS["artifact.ingestInit"],
    async (request) => ingest.init(request),
  );
  registerDescribedMethod(
    registry,
    ARTIFACT_METHOD_DESCRIPTORS["artifact.ingestChunk"],
    async (request) => ingest.chunk(request),
  );
  registerDescribedMethod(
    registry,
    ARTIFACT_METHOD_DESCRIPTORS["artifact.ingestComplete"],
    async (request, ctx) =>
      ingest.complete(request.ingestId, callingDeviceOf(ctx, "artifact.ingestComplete")),
  );
}
