// The clone verbs through the daemon's real method registry, while the clone service is not
// running: each answers the typed unavailable error, carrying a failed start's own text or, for a
// start never made, no message at all.

import { describe, expect, it } from "vitest";

import { REPO_CLONE_UNAVAILABLE_CODE } from "@ai-sidekicks/contracts/repo/clone";

import { MethodRegistryImpl } from "../../../registry.js";
import { StreamingPrimitive } from "../../../streaming-primitive.js";
import { registerRepoCloneMethods, type RepoCloneMethodsDeps } from "../clone.js";

function dispatchClone(clones: RepoCloneMethodsDeps["clones"]): Promise<unknown> {
  const registry = new MethodRegistryImpl();
  registerRepoCloneMethods(registry, {
    streamingPrimitive: new StreamingPrimitive({ registry, send: () => {} }),
    outboundQueue: { isFull: () => false, onceDrained: () => () => {} },
    clones,
  });
  return registry.dispatch("repo.clone", { url: "https://host/team/app.git" }, { transportId: 1 });
}

describe("repo.clone while the clone service is not running", () => {
  it("answers repo.clone_unavailable with the start's own failure text", async () => {
    // The askpass program's socket could not be made.
    await expect(
      dispatchClone(Promise.reject(new Error("listen EACCES: permission denied"))),
    ).rejects.toMatchObject({
      code: REPO_CLONE_UNAVAILABLE_CODE,
      message: "listen EACCES: permission denied",
    });
  });

  it("answers repo.clone_unavailable with no message for a start never made", async () => {
    await expect(dispatchClone(Promise.resolve(null))).rejects.toMatchObject({
      code: REPO_CLONE_UNAVAILABLE_CODE,
      message: "",
    });
  });
});
