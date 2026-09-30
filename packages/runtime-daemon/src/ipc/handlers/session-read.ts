// `session.read` JSON-RPC handler: one session's snapshot and its timeline cursors.
//
// The session's own facts and cursors come from the session log through
// `SessionReadDeps.readSession`; the unsent composer draft comes from the draft store,
// which is where `session.draftUpdate` holds it.
//
// Why `mutating: false`: reading a session changes nothing, so the pre-handshake
// mutating-op gate lets it through on a connection whose version negotiation failed.
// A read-only client stays able to read across a version mismatch.

import type {
  MethodRegistry,
  SessionReadRequest,
  SessionReadResponse,
  SessionSnapshot,
} from "@ai-sidekicks/contracts";
import { SESSION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts";

import type { SessionDraftStore } from "../../session/session-draft-store.js";

import { registerDescribedMethod } from "./register-described-method.js";

/** A session's read as the session log answers it: everything but the held draft. */
export interface SessionLogRead {
  session: Omit<SessionSnapshot, "draft">;
  timelineCursors: SessionReadResponse["timelineCursors"];
}

/** What `session.read`'s handler reads from. */
export interface SessionReadDeps {
  /**
   * Reads the session's snapshot and timeline cursors from the session log. An unknown
   * session throws `SessionNotFoundError` (`ipc/session-errors.ts`), which the gateway
   * maps to `-32602` with `data.type: "session.not_found"`.
   */
  readonly readSession: (request: SessionReadRequest) => Promise<SessionLogRead>;
  readonly draftStore: Pick<SessionDraftStore, "read">;
}

/** Binds `session.read` onto the registry. */
export function registerSessionRead(registry: MethodRegistry, deps: SessionReadDeps): void {
  registerDescribedMethod(registry, SESSION_METHOD_DESCRIPTORS["session.read"], async (request) => {
    const logRead = await deps.readSession(request);
    return {
      session: { ...logRead.session, draft: deps.draftStore.read(request.sessionId) },
      timelineCursors: logRead.timelineCursors,
    };
  });
}
