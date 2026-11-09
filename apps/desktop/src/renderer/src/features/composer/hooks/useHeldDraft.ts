// One session's held draft, followed from the daemon and saved to it for as long as the composer
// is mounted: leaving the session unmounts the holder and saves at once, and so does the window
// closing.

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { callDaemon } from "#renderer/services/daemon/reply.js";
import { followSessionDraft } from "#renderer/services/daemon/session-draft.js";
import { readSessionId } from "#renderer/services/daemon/wire/identifiers.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import type { DraftStore } from "#renderer/store/drafts.js";
import { composerDraftKey } from "../draft-line/draft-key.js";
import { ComposerHeldDraft, type HeldDraftReading } from "../held-draft/holder.js";

/** The holder of one session's held draft, and what it holds now. */
export interface HeldDraftBinding {
  readonly heldDraft: ComposerHeldDraft;
  readonly reading: HeldDraftReading;
}

/**
 * The holder of `sessionId`'s held draft, following and saving the daemon's draft while mounted.
 * A session id the wire would not take follows and saves nothing, and the composer holds only
 * what is typed here.
 */
export function useHeldDraft(
  bridge: PlatformBridge,
  sessionId: string,
  draftStore: DraftStore,
): HeldDraftBinding {
  const clock = useClock();
  // Holds no connection or timer until `start`, so a holder a discarded render made needs no
  // closing.
  const heldDraft = useMemo(() => {
    const wireSessionId = readSessionId(sessionId);
    const draftKey = composerDraftKey(sessionId);
    return new ComposerHeldDraft({
      draftStore,
      draftKey,
      ...(wireSessionId === undefined
        ? {}
        : {
            saving: {
              clock,
              save: (draft, expectedRevision) =>
                callDaemon(bridge, "session.draft.update", {
                  sessionId: wireSessionId,
                  draft,
                  expectedRevision,
                }),
            },
          }),
    });
  }, [bridge, clock, draftStore, sessionId]);
  useEffect(() => {
    const wireSessionId = readSessionId(sessionId);
    if (wireSessionId === undefined) {
      return undefined;
    }
    const stopFollowing = followSessionDraft(bridge, wireSessionId, heldDraft.take);
    heldDraft.start();
    const ownerWindow = globalThis.window;
    const saveOnClose = (): void => {
      heldDraft.saveNow();
    };
    ownerWindow.addEventListener("pagehide", saveOnClose);
    return () => {
      ownerWindow.removeEventListener("pagehide", saveOnClose);
      stopFollowing();
      heldDraft.stop();
    };
  }, [bridge, sessionId, heldDraft]);
  const reading = useSyncExternalStore(heldDraft.subscribe, heldDraft.snapshot);
  return { heldDraft, reading };
}
