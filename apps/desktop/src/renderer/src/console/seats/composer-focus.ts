// Asking the composer for the caret, from a surface that is not the composer.
//
// `seats/composer-seat.ts` is the contract for what the workspace HANDS the composer
// on every render. This is the other direction, and it needed its own seam: a surface
// that tells a person "send a message to an agent and its run appears here" is telling
// them to do something it cannot help them start, and every remedy inside the console
// — a route change, a palette open, a pane focus — puts the caret somewhere other than
// the line they were pointed at.
//
// IT CARRIES A REQUEST AND NOT A HANDLE. The composer's input element belongs to the
// composer family and is created and destroyed by its own mount; publishing a `ref`
// through a seat would hand every view family a live DOM node whose lifetime it does
// not own, and a family holding a stale one would call `focus()` on a detached
// element and see nothing happen. What travels here is the ASK — one event, no
// payload — and the composer decides what focusing means, which is the same split
// every other seat in this directory takes.
//
// AN ASK WITH NO COMPOSER MOUNTED IS DROPPED, DELIBERATELY. There is no queue and no
// replay: a request is about a person's attention right now, and a caret that jumps
// into a composer which mounted seconds later would move focus out from under
// whatever they had started doing instead. The emitter's own no-sink case is exactly
// that behaviour, so nothing here adds a buffer to defeat it.
//
// IT IS A CHANNEL AND NOT A STORE, so nothing re-renders on an ask. Focus is an
// imperative act on a DOM element, and routing it through rendered state would mean
// holding a "wanted focus" flag that has to be cleared, can be read twice, and shows
// up in every snapshot of a store that is otherwise about what is on screen.

import { Emitter, type Unsubscribe } from "../core/index.js";

/** The one thing the ask carries: that somebody asked. */
export type ComposerFocusRequest = Readonly<Record<string, never>>;

const composerFocusRequests = new Emitter<ComposerFocusRequest>("composer focus request");

/**
 * Ask whichever composer is mounted to take the caret.
 *
 * Called by a surface that has just told a person to type something — the runs
 * pane's empty state is the first — and answered by nobody at all when no composer
 * is mounted, which is a window with no session open.
 */
export function requestComposerFocus(): void {
  composerFocusRequests.emit({});
}

/**
 * The composer's side: take the caret when asked. Unsubscribed on unmount.
 *
 * The sink is called with NO argument rather than handed the emitter's event value.
 * The emitter is a generic fan-out and delivers one, but this seam's whole claim is
 * that the ask carries nothing — a listener that received a value would eventually be
 * a listener that branched on one, and the seam would have grown a payload nobody
 * declared.
 */
export function subscribeToComposerFocus(takeFocus: () => void): Unsubscribe {
  return composerFocusRequests.subscribe(() => {
    takeFocus();
  });
}

/** How many composers are listening. Read by tests; never a branch in shipped code. */
export function composerFocusListenerCount(): number {
  return composerFocusRequests.sinkCount;
}
