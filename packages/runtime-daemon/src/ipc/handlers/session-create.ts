// `session.create`: starts a session where the request binds it, led by the lead it names.
//
// The registry parses the request against the descriptor's schema before the handler runs, so
// a malformed request never reaches `createSession`. A failure thrown from the deps is mapped
// to the JSON-RPC error envelope outside this file. The descriptor is `mutating`, so the gate
// refuses it on a connection whose `daemon.hello` has not completed.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc-registry";
import type {
  SessionCreateRequest,
  SessionCreateResponse,
} from "@ai-sidekicks/contracts/session-directory";
import { SESSION_DIRECTORY_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session-directory";

import { registerDescribedMethod } from "./register-described-method.js";

/** What `session.create`'s handler calls. */
export interface SessionCreateDeps {
  /**
   * Creates the session and answers its id, shape and state. The implementation appends
   * `session.created` before it answers, and mints the id with the daemon-wide `mintUuidV7`:
   * the wire schemas accept any UUID version only because control-plane ids are v4, and a
   * daemon id is never v4.
   */
  readonly createSession: (request: SessionCreateRequest) => Promise<SessionCreateResponse>;
}

/** Binds `session.create` onto the registry. A second binding on one registry throws. */
export function registerSessionCreate(registry: MethodRegistry, deps: SessionCreateDeps): void {
  registerDescribedMethod(
    registry,
    SESSION_DIRECTORY_METHOD_DESCRIPTORS["session.create"],
    async (request) => deps.createSession(request),
  );
}
