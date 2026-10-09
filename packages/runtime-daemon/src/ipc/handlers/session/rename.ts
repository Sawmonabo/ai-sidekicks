// `session.rename`: names the session, or with `null` clears its name. The descriptor is
// `mutating`, so the gate refuses it on a connection whose `daemon.hello` was incompatible.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { SESSION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/methods";

import type { SessionChanges } from "../../../session/changes.js";

import { registerDescribedMethod } from "../register-described-method.js";

/** What `session.rename`'s handler calls. */
export interface SessionRenameDeps {
  readonly changes: Pick<SessionChanges, "rename">;
}

/** Binds `session.rename` onto the registry. */
export function registerSessionRename(registry: MethodRegistry, deps: SessionRenameDeps): void {
  registerDescribedMethod(registry, SESSION_METHOD_DESCRIPTORS["session.rename"], (request) =>
    deps.changes.rename(request),
  );
}
