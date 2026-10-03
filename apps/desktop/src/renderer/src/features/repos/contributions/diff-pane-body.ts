// The diff pane's body, loaded through a loader-backed registration so the diff parser
// (`diff`) and the virtualized row renderer stay off the first-paint import graph. Only the
// `import()` in `panes.ts` may name this module; a static import would undo that. The inline
// diff card is not behind this boundary: it renders in the transcript a session opens on.

import { createElement } from "react";

import { DiffPane } from "../diff/components/DiffPane.js";
import { paneBodyForKind } from "@renderer/registries/panes/pane-body-for-kind.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";

/**
 * The diff pane's body at an address the pane layout resolved to this kind. Named `Body`
 * because a loader module publishes that export name. `paneBodyForKind` narrows the context to
 * this kind and throws on another, which only a body registered under the wrong kind receives.
 */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyForKind("diff", (context) =>
  createElement(DiffPane, { context }),
);
