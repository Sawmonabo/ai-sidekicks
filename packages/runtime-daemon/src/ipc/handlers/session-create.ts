// `session.create` JSON-RPC handler: starts a session where the request binds it, led by the
// lead it names.
//
// The registry parses the request against the descriptor's schema before the handler runs, so
// a malformed request never reaches `SessionCreateDeps.createSession`. A domain failure thrown
// from the deps is mapped to the JSON-RPC error envelope by the registry's dispatch wrapper;
// this file never builds an envelope itself.
//
// Why `mutating: true`: creating a session appends `session.created`, so the pre-handshake
// mutating-op gate refuses it on a connection whose `daemon.hello` has not completed.

import type {
  MethodRegistry,
  SessionCreateRequest,
  SessionCreateResponse,
} from "@ai-sidekicks/contracts";
import { SESSION_DIRECTORY_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts";

import { registerDescribedMethod } from "./register-described-method.js";

/** What `session.create`'s handler calls. */
export interface SessionCreateDeps {
  /**
   * Creates the session and answers its id, shape and state.
   *
   * The session id is minted through the daemon-wide `mintUuidV7`
   * (`runtime-daemon/src/ids/uuid-v7.ts`), as every daemon-side row and event id is. The
   * wire schemas accept any UUID version only because control-plane ids are Postgres v4;
   * that tolerance does not let a daemon id be v4. The implementation appends
   * `session.created` before it answers.
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
