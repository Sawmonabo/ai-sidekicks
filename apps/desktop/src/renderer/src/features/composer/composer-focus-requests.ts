// Asking the composer for the caret from a view that is not the composer. It carries a request,
// not a `ref`: the input element's lifetime belongs to the composer, and a stale handle would call
// `focus()` on a detached node. An ask with no composer mounted is dropped, with no queue or
// replay, so a late mount never pulls focus from what the person moved on to. It is an event, not
// a store, so nothing re-renders on an ask.

import type { Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "@renderer/lib/emitter.js";

/** The one thing the ask carries: that somebody asked. */
export type ComposerFocusRequest = Readonly<Record<string, never>>;

const composerFocusRequests = new Emitter<ComposerFocusRequest>("composer focus request");

/** Ask whichever composer is mounted to take the caret; nobody answers when none is mounted. */
export function requestComposerFocus(): void {
  composerFocusRequests.emit({});
}

/**
 * The composer's side: take the caret when asked. The sink is called with no argument so the
 * seam never grows a payload; unsubscribe on unmount.
 */
export function subscribeToComposerFocus(takeFocus: () => void): Unsubscribe {
  return composerFocusRequests.subscribe(() => {
    takeFocus();
  });
}
