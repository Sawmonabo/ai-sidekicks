// `session.draftUpdate`: saves the session's unsent composer draft in the daemon.
//
// The composer writes the draft one second after typing pauses and at once when the
// session is left or the window closes, and Send clears it with an empty draft. An
// unknown session is refused with `session.not_found`.

import type { MethodRegistry } from "@ai-sidekicks/contracts";
import { SESSION_DRAFT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts";

import type { SessionDraftStore } from "../../session/session-draft-store.js";

import { registerDescribedMethod } from "./register-described-method.js";

/** Binds `session.draftUpdate` onto the registry, answered from `draftStore`. */
export function registerSessionDraftUpdate(
  registry: MethodRegistry,
  draftStore: SessionDraftStore,
): void {
  registerDescribedMethod(
    registry,
    SESSION_DRAFT_METHOD_DESCRIPTORS["session.draftUpdate"],
    async (request) => ({
      sessionId: request.sessionId,
      updatedAt: draftStore.write(request.sessionId, request.text),
    }),
  );
}
