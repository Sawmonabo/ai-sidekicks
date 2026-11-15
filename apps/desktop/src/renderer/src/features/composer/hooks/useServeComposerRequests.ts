// The composer's answer to what the transcript asks of it, for as long as it is mounted: words
// handed back go into the draft, a waiting message goes into the draft to edit with what the draft
// held set aside, and `Send now` goes through the run controls' one dispatcher.

import { useEffect } from "react";

import type { DraftStore } from "#renderer/store/drafts.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { returnWordsToDraft } from "../draft-line/returned-words.js";
import { composerDraftKey } from "../draft-line/draft-key.js";

/** Serve the session's composer requests while the composer is mounted. */
export function useServeComposerRequests(
  sessionStore: SessionStore,
  draftStore: DraftStore,
  sendNow: (queueItemId: string) => Promise<void>,
): void {
  const latestSendNow = useLatestRef(sendNow);
  useEffect(() => {
    const draftKey = composerDraftKey(sessionStore.sessionId);
    const { composerRequests } = sessionStore;
    return composerRequests.serve({
      returnToDraft: (content) => {
        returnWordsToDraft(draftStore, draftKey, content);
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
  }, [sessionStore, draftStore, latestSendNow]);
}
