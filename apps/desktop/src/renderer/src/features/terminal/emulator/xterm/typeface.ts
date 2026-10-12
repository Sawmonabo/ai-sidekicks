// The face and size the grid draws in, taken from the element it draws into.
//
// `@xterm/xterm` measures its cell from its own `fontFamily` and `fontSize` options, never from
// the element it opens onto, so the stylesheet's `--meridian-font-mono` and type step alone left
// the grid on the library's default face and size and sized the pane from them. Reading the mount
// element's computed face and size keeps the stylesheet the one source of both, so the grid
// follows the text size as every other surface does.

/** The part of `Terminal` this module touches, so the rule can be proved against a plain object. */
export interface MonospaceTypefaceTarget {
  readonly options: { fontFamily?: string | undefined; fontSize?: number | undefined };
}

/**
 * Tell an emulator which face and size its mount element is in, in CSS px. Each is skipped when
 * unchanged, because assigning re-measures the cell and re-renders every row, and `attach` runs on
 * every remount. A detached element and a DOM shim declare an empty face and no size, which leave
 * the emulator's own alone.
 */
export function applyDeclaredMonospaceTypeface(
  terminal: MonospaceTypefaceTarget,
  mountElement: HTMLElement,
): void {
  const declared = mountElement.ownerDocument.defaultView?.getComputedStyle(mountElement);
  if (declared === undefined) {
    return;
  }
  if (declared.fontFamily !== "" && declared.fontFamily !== terminal.options.fontFamily) {
    terminal.options.fontFamily = declared.fontFamily;
  }
  const fontSizePx = Number.parseFloat(declared.fontSize);
  if (Number.isFinite(fontSizePx) && fontSizePx !== terminal.options.fontSize) {
    terminal.options.fontSize = fontSizePx;
  }
}
