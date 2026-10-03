// Names the filled-accent class and imports its sheet, so a control that reads the name gets the
// face with it. `accent-fill.css` must declare the selector the constant names.

import "./accent-fill.css";

/**
 * The class that gives a control the whole accent as its face. It carries no size, so a consumer
 * keeps its own padding; a card or pane carries one filled primary action.
 */
export const ACCENT_FILL_CLASS = "meridian-accent-fill";
