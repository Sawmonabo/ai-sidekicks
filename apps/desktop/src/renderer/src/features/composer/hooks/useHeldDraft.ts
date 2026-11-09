// One session's held draft, followed from the daemon for as long as the composer is mounted.

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { followSessionDraft } from "#renderer/services/daemon/session-draft.js";
import { readSessionId } from "#renderer/services/daemon/wire/identifiers.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { DraftStore } from "#renderer/store/drafts.js";
import { composerDraftKey } from "../draft-line/draft-key.js";
import { ComposerHeldDraft, type HeldDraftReading } from "../held-draft.js";

/** The holder of one session's held draft, and what it holds now. */
export interface HeldDraftBinding {
  readonly heldDraft: ComposerHeldDraft;
  readonly reading: HeldDraftReading;
}

/**
 * The holder of `sessionId`'s held draft, following the daemon's draft while mounted. A session
 * id the wire would not take follows nothing, and the composer holds only what is typed here.
 */
export function useHeldDraft(
  bridge: PlatformBridge,
  sessionId: string,
  draftStore: DraftStore,
): HeldDraftBinding {
  // Holds no connection of its own, so a holder a discarded render made needs no closing.
  const heldDraft = useMemo(
    () => new ComposerHeldDraft(draftStore, composerDraftKey(sessionId)),
    [draftStore, sessionId],
  );
  useEffect(() => {
    const wireSessionId = readSessionId(sessionId);
    return wireSessionId === undefined
      ? undefined
      : followSessionDraft(bridge, wireSessionId, heldDraft.take);
  }, [bridge, sessionId, heldDraft]);
  const reading = useSyncExternalStore(heldDraft.subscribe, heldDraft.snapshot);
  return { heldDraft, reading };
}
