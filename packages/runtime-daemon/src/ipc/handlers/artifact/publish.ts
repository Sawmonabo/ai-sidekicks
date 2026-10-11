// `artifact.publish`: publishes an artifact from a payload a client sends whole, attributed to the
// calling device. The payload crossed into the daemon, so it runs the ingest pipeline, and a file
// is refused in favor of the ingest calls.

import { ARTIFACT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/artifacts/methods";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";

import type { ArtifactPublishService } from "../../../artifacts/publish.js";

import { callingDeviceOf } from "../../registry.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** Binds `artifact.publish` onto the registry, answered by `publisher`. */
export function registerArtifactPublish(
  registry: MethodRegistry,
  publisher: Pick<ArtifactPublishService, "publish">,
): void {
  registerDescribedMethod(
    registry,
    ARTIFACT_METHOD_DESCRIPTORS["artifact.publish"],
    async (request, ctx) =>
      publisher.publish(request, {
        kind: "request",
        deviceId: callingDeviceOf(ctx, "artifact.publish"),
      }),
  );
}
