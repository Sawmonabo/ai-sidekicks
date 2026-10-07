// `session.pin`, `session.unpin`, `session.mute` and `session.unmute`: the marks the daemon holds
// for every device. Each answers `{}`, and one that finds the mark already as it asks appends
// nothing. Each descriptor is `mutating`.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { SESSION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/methods";

import type { SessionChanges } from "../../../session/changes.js";

import { registerDescribedMethod } from "../register-described-method.js";

/** What the mark verbs' handlers call. */
export interface SessionMarkDeps {
  readonly changes: Pick<SessionChanges, "pin" | "unpin" | "mute" | "unmute">;
}

/** Binds `session.pin`, `session.unpin`, `session.mute` and `session.unmute` onto the registry. */
export function registerSessionMarkMethods(registry: MethodRegistry, deps: SessionMarkDeps): void {
  registerDescribedMethod(registry, SESSION_METHOD_DESCRIPTORS["session.pin"], async (request) => {
    await deps.changes.pin(request.sessionId);
    return {};
  });
  registerDescribedMethod(
    registry,
    SESSION_METHOD_DESCRIPTORS["session.unpin"],
    async (request) => {
      await deps.changes.unpin(request.sessionId);
      return {};
    },
  );
  registerDescribedMethod(registry, SESSION_METHOD_DESCRIPTORS["session.mute"], async (request) => {
    await deps.changes.mute(request.sessionId);
    return {};
  });
  registerDescribedMethod(
    registry,
    SESSION_METHOD_DESCRIPTORS["session.unmute"],
    async (request) => {
      await deps.changes.unmute(request.sessionId);
      return {};
    },
  );
}
