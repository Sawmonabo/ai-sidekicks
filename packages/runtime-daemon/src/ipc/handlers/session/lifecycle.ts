// `session.archive`, `session.reactivate` and `session.close`: a session's moves between the live
// list, the archived ones and closed. Each answers `{}`, and one that finds the session already
// where it asks appends nothing. Each descriptor is `mutating`.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { SESSION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/methods";

import type { SessionChanges } from "../../../session/changes.js";

import { registerDescribedMethod } from "../register-described-method.js";

/** What the lifecycle verbs' handlers call. */
export interface SessionLifecycleDeps {
  readonly changes: Pick<SessionChanges, "archive" | "reactivate" | "close">;
}

/** Binds `session.archive`, `session.reactivate` and `session.close` onto the registry. */
export function registerSessionLifecycleMethods(
  registry: MethodRegistry,
  deps: SessionLifecycleDeps,
): void {
  registerDescribedMethod(
    registry,
    SESSION_METHOD_DESCRIPTORS["session.archive"],
    async (request) => {
      await deps.changes.archive(request.sessionId);
      return {};
    },
  );
  registerDescribedMethod(
    registry,
    SESSION_METHOD_DESCRIPTORS["session.reactivate"],
    async (request) => {
      await deps.changes.reactivate(request.sessionId);
      return {};
    },
  );
  registerDescribedMethod(
    registry,
    SESSION_METHOD_DESCRIPTORS["session.close"],
    async (request) => {
      await deps.changes.close(request.sessionId);
      return {};
    },
  );
}
