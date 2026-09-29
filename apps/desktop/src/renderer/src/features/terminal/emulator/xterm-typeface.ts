// The face the grid draws in, taken from the surface it draws into.
//
// `@xterm/xterm` measures its cell from ITS OWN `fontFamily` option and never from
// the element it was opened onto. So `emulator.css`'s
// `font-family: var(--meridian-font-mono)` on `.meridian-terminal-host__surface`
// reached the accessible row list and nothing else: the grid drew in the library's
// default `courier-new, courier, monospace` while every other monospace figure in
// the console drew in the console's own stack. Two faces for one role, and the
// grid's row height — which is what sizes the whole pane — came from the one nobody
// chose.
//
// Reading the host's COMPUTED family rather than importing the token keeps one
// source of truth. The stylesheet already declares which face this surface is in;
// a document that overrides the custom property is followed rather than
// second-guessed; and no copy of a value `tokens/palette.ts` owns lives here.

/**
 * The part of `Terminal` this module touches.
 *
 * Structural rather than the class itself, so the rule can be proved against a
 * plain object. `Terminal` satisfies it, and a test that had to build a real
 * emulator to check which face it was told to use would be measuring the library.
 */
export interface TypefaceBearingTerminal {
  readonly options: { fontFamily?: string | undefined };
}

/**
 * The face declared on a host element, or nothing when it declares none.
 *
 * A detached element and a DOM shim both answer with an empty string, and the
 * library's default is a worse face but a working one — so an absent declaration
 * leaves the emulator alone rather than clearing what it has.
 */
export function readDeclaredMonospaceFamily(hostElement: HTMLElement): string | undefined {
  const declared = hostElement.ownerDocument.defaultView?.getComputedStyle(hostElement).fontFamily;
  return declared === undefined || declared === "" ? undefined : declared;
}

/**
 * Tell an emulator which face its host is in.
 *
 * Assigning is skipped when the answer has not moved, because the library re-measures
 * its cell and re-renders every row on the write — and `attach` runs on every remount,
 * where the answer is almost always the one already set.
 */
export function applyDeclaredMonospaceFamily(
  terminal: TypefaceBearingTerminal,
  hostElement: HTMLElement,
): void {
  const declared = readDeclaredMonospaceFamily(hostElement);
  if (declared === undefined || declared === terminal.options.fontFamily) {
    return;
  }
  terminal.options.fontFamily = declared;
}
