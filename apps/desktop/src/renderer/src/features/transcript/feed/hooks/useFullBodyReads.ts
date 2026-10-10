import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { type TranscriptBodyRead } from "#renderer/services/daemon/transcript/body.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { FullBodyReads } from "../../rows/full-body-reads.js";

/**
 * Hold one session's large-body reads through `readBody`, or `undefined` in a composition with no
 * body read. Held per read client and session, so another of either starts with none opened.
 */
export function useFullBodyReads(
  sessionStore: SessionStore,
  readBody: TranscriptBodyRead | undefined,
): FullBodyReads | undefined {
  return useSubjectScopedState(readBody ?? NO_BODY_READ, sessionStore.sessionId, () =>
    readBody === undefined ? undefined : new FullBodyReads(sessionStore, readBody),
  ).value;
}

/** The subject a composition with no body read is held under. */
const NO_BODY_READ: object = Object.freeze({});
