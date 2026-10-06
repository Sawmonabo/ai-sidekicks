// The one edge into the import panel's deferred body, and the only asynchronous one.
//
// `body.ts` is the chunk root; this module stays on the initial graph
// and reaches the body only through the `import()` in the mount (the `import type` is
// erased by the compiler).
//
// A `LoaderBackedBody` is the console's one loader-backed body: one in-flight promise, one
// component identity so a re-render does not remount a half-typed form, and the settled
// body rendered directly so reopening never suspends. While pending it draws nothing.

import { LoaderBackedBody } from "#renderer/components/LazyBody/loader.js";
import type { ProviderImportPanelProps } from "../ProviderImportPanel.js";

/**
 * The import panel, mounted from its own chunk.
 */
export const providerImportPanelMount: LoaderBackedBody<ProviderImportPanelProps> =
  new LoaderBackedBody(
    () => import("./body.js"),
    () => null,
  );
