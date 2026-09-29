// The one edge into the import panel's deferred body, and the only one that is
// asynchronous.
//
// WHAT THIS MODULE IS. `provider-import-panel-body.ts` is the chunk root and states why
// its body is off the initial import graph; this module is the half that stays ON it —
// the mount, and nothing else. It holds no form knowledge and imports the body at run
// time only through the `import()` call inside the mount: the `import type` line below
// is erased by the compiler.
//
// A `LoadedLazyBody` rather than a `lazy()` of this module's own, because that class is
// already the console's one answer to a loader-backed body: one in-flight promise however
// many callers ask, one component identity so a host re-render does not remount a
// half-typed form, a fresh payload only where a load rejected so the error boundary's
// retry reaches a live loader, and the settled body rendered directly once the chunk has
// landed — so a form disclosed, dismissed, and disclosed again never suspends at all.
//
// A `const` and not a module-level `let`: the memo is the class's own private field,
// which is what the state-and-views rule in `apps/desktop/AGENTS.md` asks for.
//
// WHAT A PENDING BODY DRAWS is the marker `seats/pane/pending-pane-body.ts` owns and nothing
// else: no spinner, no skeleton, and none of rule 8's five kinds of nothing. What is
// absent is a MODULE rather than anything about the act, and the marker rides a `hidden`
// element, so what the wait costs the layout is nothing and the screenshot tier refuses
// to photograph a tree still carrying one.

import { LoadedLazyBody, reservedBodyRegion } from "@renderer/console/seats/index.js";
import type { ProviderImportPanelProps } from "./ProviderImportPanel.js";

/**
 * What a pending import panel stamps, so a refused capture says WHICH body was loading.
 *
 * Not a pane kind — the body is not a pane — so the value is the body's own name.
 */
const PROVIDER_IMPORT_PANEL_PENDING_BODY = "provider-import-panel";

/**
 * The import panel, mounted from its own chunk.
 */
export const providerImportPanelMount: LoadedLazyBody<ProviderImportPanelProps> =
  new LoadedLazyBody(
    () => import("./provider-import-panel-body.js"),
    () => reservedBodyRegion(PROVIDER_IMPORT_PANEL_PENDING_BODY),
  );
