// The browser family's door.
//
// The family owns the embedded browser: the pane's chrome, the page picker, the
// element-reference capture, and the two node-wide settings that govern them. What
// it owns TODAY is the pane's seat on the deck — the chrome is built once
// `Plan-023 §Console growth slate` rows 1, 2, and 4 leave the slate and the
// embedded-browser Type-2 ADR lands, and the shell it is built into is registered
// here so that arrival is an edit to a mounted pane rather than a new mount.
//
// WHY THE FAMILY REGISTERS AND THE PANE DIRECTORY DOES NOT. `console/panes/<kind>/`
// holds a pane BODY; `console/<family>/` is what the seat board composes. Keeping
// the registration here means the seat board names families rather than reaching
// into a body's directory, and it means the day this family grows a second pane or
// a settings surface, the seat board does not change at all.
//
// The family sits above the seats door in the console's DAG and imports no sibling
// view family through any other path.

// The family's stylesheet is imported HERE and nowhere else, which is the rule
// `primitives/index.ts` and `frame/index.ts` already follow: one edge into the sheet
// per bundle, and no surface can render a shape whose CSS never arrived.
import "./browser.css";

import type { ConsolePaneRegistry } from "../seats/index.js";
import { BROWSER_PANE_DESCRIPTOR } from "../panes/browser/index.js";

/**
 * Claim the browser family's pane kinds.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for
 * `registerConsolePanes`' reason: a test composes into a registry it owns, and an
 * auxiliary window composes a different subset without a second code path.
 */
export function registerBrowserPanes(registry: ConsolePaneRegistry): void {
  registry.register(BROWSER_PANE_DESCRIPTOR);
}
