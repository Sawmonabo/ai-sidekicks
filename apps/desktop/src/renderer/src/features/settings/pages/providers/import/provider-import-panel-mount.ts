// The one edge into the import panel's deferred body, and the only asynchronous one.
//
// `provider-import-panel-body.ts` is the chunk root; this module stays on the initial graph
// and reaches the body only through the `import()` in the mount (the `import type` is
// erased by the compiler).
//
// A `LoaderBackedBody` is the console's one loader-backed body: one in-flight promise, one
// component identity so a re-render does not remount a half-typed form, and the settled
// body rendered directly so reopening never suspends. While pending it draws only the
// hidden marker from `components/LazyBody/pending-body-marker.ts`, which costs the layout
// nothing and which the screenshot tier refuses to photograph.

import { LoaderBackedBody } from "@renderer/components/LazyBody/lazy-body.js";
import { reservedBodyRegion } from "@renderer/components/LazyBody/pending-body-marker.js";
import type { ProviderImportPanelProps } from "./ProviderImportPanel.js";

/**
 * What a pending import panel stamps, so a refused capture says which body was loading.
 *
 * Not a pane kind — the body is not a pane — so the value is the body's own name.
 */
const PROVIDER_IMPORT_PANEL_PENDING_BODY = "provider-import-panel";

/**
 * The import panel, mounted from its own chunk.
 */
export const providerImportPanelMount: LoaderBackedBody<ProviderImportPanelProps> =
  new LoaderBackedBody(
    () => import("./provider-import-panel-body.js"),
    () => reservedBodyRegion(PROVIDER_IMPORT_PANEL_PENDING_BODY),
  );
