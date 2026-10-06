// Motion a script draws fires no event of its own: an inline `transform` write starts no CSS
// transition and `element.animate()` fires no `animationstart`. Whatever moves an element that
// way announces it here, so an observer listening at the document hears it as it would a CSS
// transition starting.

/** The event an element moved by script carries; it bubbles, so the document hears it. */
export const SCRIPTED_MOTION_EVENT = "meridian-scripted-motion";

/**
 * Tells whoever listens in `element`'s document that a script is moving it. The event is made by
 * that document's own window, since every window a person sees is a separate document.
 */
export function announceScriptedMotion(element: Element): void {
  const ownerWindow = element.ownerDocument.defaultView;
  if (ownerWindow === null) {
    return;
  }
  element.dispatchEvent(new ownerWindow.Event(SCRIPTED_MOTION_EVENT, { bubbles: true }));
}
