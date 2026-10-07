// The person's session tag verbs: `session.tagAdd`, `session.tagRemove` and `session.tagList`,
// the tags in use that `Add tag` suggests.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { SESSION_TAG_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/tags";

import type { SessionTagService } from "../../../session/tags/service.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** What the tag verbs call. */
export interface SessionTagMethodsDeps {
  readonly tags: Pick<SessionTagService, "add" | "remove" | "list">;
}

/** Binds the three tag verbs onto the registry. A second binding on one registry throws. */
export function registerSessionTagMethods(
  registry: MethodRegistry,
  deps: SessionTagMethodsDeps,
): void {
  registerDescribedMethod(
    registry,
    SESSION_TAG_METHOD_DESCRIPTORS["session.tagAdd"],
    async (request) => {
      await deps.tags.add(request);
      return {};
    },
  );
  registerDescribedMethod(
    registry,
    SESSION_TAG_METHOD_DESCRIPTORS["session.tagRemove"],
    async (request) => {
      await deps.tags.remove(request);
      return {};
    },
  );
  registerDescribedMethod(registry, SESSION_TAG_METHOD_DESCRIPTORS["session.tagList"], async () =>
    deps.tags.list(),
  );
}
