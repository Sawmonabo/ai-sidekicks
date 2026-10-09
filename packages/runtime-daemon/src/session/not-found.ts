// The one `session.not_found` refusal a session's create, conversion, changes and reads raise for
// an id this daemon holds no session under.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { SessionNotFoundError } from "../ipc/session-errors.js";

/** The refusal of `sessionId`, which names no session this daemon holds. */
export function sessionNotFound(sessionId: SessionId): SessionNotFoundError {
  return new SessionNotFoundError("This daemon holds no such session.", { sessionId });
}
