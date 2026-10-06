// The preview pane's body, as the pane registry loads it. It is registered as a loader
// (`body: () => import("../pane-body.js")`) so the pane and its geometry become their own chunk,
// off the initial import graph.

import { paneBodyForKind } from "#renderer/registries/panes/body-for-kind.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";
import { PreviewPane } from "./PreviewPane.js";

/**
 * The preview pane, as the pane layout holds it. Named `Body` because
 * `components/LazyBody/loader.ts` fixes the export name a loader module publishes.
 *
 * The body is a main-process view hosted in the window that owns the pane, and no mechanism
 * moves that host between windows. `render` goes through `paneBodyForKind` because the registry
 * holds one `render` over every kind; the adapter narrows to `browser`, and a context of another
 * kind throws, since only a body registered under the wrong kind can receive one.
 */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyForKind(
  "browser",
  PreviewPane,
);
