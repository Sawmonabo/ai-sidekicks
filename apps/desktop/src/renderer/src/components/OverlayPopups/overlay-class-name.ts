// The class every overlay's outermost box and popup wear beside the caller's own, which cuts them
// out of the window's drag region. Loading it here loads the overlays' sheet with it.

import "./OverlayPopups.css";

/** `className` with the overlay class in front, for an overlay's outermost box and its popup. */
export function overlayClassName(className: string | undefined): string {
  return className === undefined ? "meridian-overlay" : `meridian-overlay ${className}`;
}
