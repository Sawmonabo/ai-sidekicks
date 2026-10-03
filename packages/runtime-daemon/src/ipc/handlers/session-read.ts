// `session.read`: one session's record and its timeline cursors. The session's facts and
// cursors come from the session log through `readSession`; the unsent composer draft comes
// from the draft store that `session.draftUpdate` writes. The descriptor is not `mutating`,
// so a read-only client can still read across a protocol version mismatch.

import type {
  MethodRegistry,
  SessionReadRequest,
  SessionReadResponse,
  SessionRecord,
} from "@ai-sidekicks/contracts";
import { SESSION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts";

import type { SessionDraftStore } from "../../session/session-draft-store.js";

import { registerDescribedMethod } from "./register-described-method.js";

/** A session's read as the session log answers it: everything but the held draft. */
export interface SessionLogRead {
  session: Omit<SessionRecord, "draft">;
  timelineCursors: SessionReadResponse["timelineCursors"];
}

/** What `session.read`'s handler reads from. */
export interface SessionReadDeps {
  /**
   * Reads the session's record and timeline cursors from the session log. An unknown
   * session throws `SessionNotFoundError`, which maps to `-32602` with
   * `data.type: "session.not_found"`; any other error becomes an internal error.
   */
  readonly readSession: (request: SessionReadRequest) => Promise<SessionLogRead>;
  /** Holds the unsent composer draft that `session.draftUpdate` writes. */
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
