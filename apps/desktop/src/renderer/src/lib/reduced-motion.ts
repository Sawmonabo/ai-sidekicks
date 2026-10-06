// Whether a window asks for reduced motion. Motion drawn by script is out of the stylesheet's
// reach, so it reads the setting itself, from the window the element is drawn in: each window a
// person sees is its own document, and the hidden console document's answer is not theirs.

/** Whether `ownerWindow` asks for reduced motion (`prefers-reduced-motion: reduce`). */
export function prefersReducedMotion(ownerWindow: Window): boolean {
  return ownerWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
