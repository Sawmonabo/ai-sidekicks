// The face the grid draws in, taken from the element it draws into.
//
// `@xterm/xterm` measures its cell from its own `fontFamily` option, never from the element it
// opens onto, so the stylesheet's `--meridian-font-mono` alone left the grid on the library's
// default face and sized the pane from it. Reading the mount element's computed family keeps
// the stylesheet the one source of the face.

/**
 * The part of `Terminal` this module touches, so the rule can be proved against a plain
 * object.
 */
export interface MonospaceTypefaceTarget {
  readonly options: { fontFamily?: string | undefined };
}

/**
 * The face declared on a mount element, or `undefined` when it declares none. A detached
 * element and a DOM shim both answer with an empty string, so an absent declaration leaves the
 * emulator's face alone.
 */
export function readDeclaredMonospaceFamily(mountElement: HTMLElement): string | undefined {
  const declared =
    mountElement.ownerDocument.defaultView?.getComputedStyle(mountElement).fontFamily;
  return declared === undefined || declared === "" ? undefined : declared;
}

/**
 * Tell an emulator which face its mount element is in. Skipped when unchanged, because
 * assigning re-measures the cell and re-renders every row, and `attach` runs on every remount.
 */
export function applyDeclaredMonospaceFamily(
  terminal: MonospaceTypefaceTarget,
  mountElement: HTMLElement,
): void {
  const declared = readDeclaredMonospaceFamily(mountElement);
  if (declared === undefined || declared === terminal.options.fontFamily) {
    return;
  }
  terminal.options.fontFamily = declared;
}
