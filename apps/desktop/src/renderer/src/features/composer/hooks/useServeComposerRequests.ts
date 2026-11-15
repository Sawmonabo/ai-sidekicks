// The composer's answer to what the transcript and a failed send ask of it, for as long as it is
// mounted: words handed back go into the draft with what the send took back beside them, through
// the session's live held draft, a waiting message goes into the draft to edit with what the draft
// held set aside, and `Send now` goes through the run controls' one dispatcher.

import { useEffect } from "react";

import type { DraftStore } from "#renderer/store/drafts.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { returnWordsToDraft } from "../draft-line/returned-words.js";
import { composerDraftKey } from "../draft-line/draft-key.js";
import type { ComposerHeldDraft } from "../held-draft/holder.js";

/** Serve the session's composer requests while the composer is mounted. */
export function useServeComposerRequests(
  sessionStore: SessionStore,
  draftStore: DraftStore,
  heldDraft: ComposerHeldDraft,
  sendNow: (queueItemId: string) => Promise<void>,
): void {
  const latestSendNow = useLatestRef(sendNow);
  useEffect(() => {
    const draftKey = composerDraftKey(sessionStore.sessionId);
    const { composerRequests } = sessionStore;
    return composerRequests.serve({
      returnToDraft: async (handBack) => {
        returnWordsToDraft(draftStore, draftKey, handBack.words);
        return handBack.sent === undefined ? undefined : await heldDraft.restoreSent(handBack.sent);
      },
      beginEdit: (edit) => {
        // A second edit puts the first row back and keeps what the draft held before the first.
        const draftBefore =
          composerRequests.editSnapshot()?.draftBefore ?? draftStore.read(draftKey)?.text ?? "";
        draftStore.write(draftKey, edit.content);
        composerRequests.publishEdit({ ...edit, draftBefore });
      },
      sendNow: (queueItemId) => latestSendNow.current(queueItemId),
    });
  }, [sessionStore, draftStore, heldDraft, latestSendNow]);
}
