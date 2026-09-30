// `session.draftUpdate`: saves the session's unsent composer draft in the daemon. The text
// replaces the draft held; an empty text clears it, which is how Send clears it. An unknown
// session is refused with `session.not_found`.

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
