// Words coming back to the draft: a send that failed, a message the transcript hands back, and a
// waiting message put into the draft to edit and then sent or left. Words handed back go ahead of
// anything typed since, so nothing the person typed is lost.

import type { DraftStore } from "#renderer/store/drafts.js";
import type { SessionStore } from "#renderer/store/session/store.js";

/** Puts `words` back into the draft under `draftKey`, ahead of anything typed there since. */
export function returnWordsToDraft(draftStore: DraftStore, draftKey: string, words: string): void {
  const typedSince = draftStore.read(draftKey)?.text ?? "";
  draftStore.write(draftKey, typedSince.length === 0 ? words : `${words}\n${typedSince}`);
}

/**
 * Leaves the edit the draft holds, if any: the draft gets back what it held before the edit and
 * the row its words. Answers whether an edit was open, so Escape is taken only when it was.
 */
export function leaveWaitingMessageEdit(
  sessionStore: SessionStore,
  draftStore: DraftStore,
  draftKey: string,
): boolean {
  const edit = sessionStore.composerRequests.editSnapshot();
  if (edit === undefined) {
    return false;
  }
  draftStore.write(draftKey, edit.draftBefore);
  sessionStore.composerRequests.publishEdit(undefined);
  return true;
}
