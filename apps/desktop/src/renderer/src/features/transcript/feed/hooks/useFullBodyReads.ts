import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "#renderer/lib/subject-scoped/disposal.js";
import { type TranscriptBodyRead } from "#renderer/services/daemon/transcript/body.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { FullBodyReads } from "../../rows/full-body-reads.js";

/**
 * Hold one session's large-body reads through `readBody`, or `undefined` in a composition with no
 * body read. Held per read client and session, so another of either starts with none opened, and
 * ended with the pane, which abandons every read still out.
 */
export function useFullBodyReads(
  sessionStore: SessionStore,
  readBody: TranscriptBodyRead | undefined,
): FullBodyReads | undefined {
  return useSubjectScopedResource(
    readBody ?? NO_BODY_READ,
    sessionStore.sessionId,
    () => (readBody === undefined ? undefined : new FullBodyReads(sessionStore, readBody)),
    FULL_BODY_READS_DISPOSAL,
  ).value;
}

/** The subject a composition with no body read is held under. */
const NO_BODY_READ: object = Object.freeze({});

/** How one session's reads end with its pane, and how ended ones are recognized. */
const FULL_BODY_READS_DISPOSAL: SubjectScopedDisposal<FullBodyReads | undefined> = {
  dispose: (reads) => {
    reads?.dispose();
  },
  isClosed: (reads) => reads?.isDisposed ?? false,
};
