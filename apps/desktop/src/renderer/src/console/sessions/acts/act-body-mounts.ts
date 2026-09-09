// The two edges into the acts bar's deferred bodies, and the only ones that are
// asynchronous.
//
// WHAT THIS MODULE IS. `join-session-form-body.ts` and `provider-import-panel-body.ts`
// are the chunk roots and each states why its body is off the initial import graph; this
// module is the half that stays ON it — the two mounts the bar's component lines became,
// and nothing else. It holds no form knowledge and imports neither body at run time: the
// two `import type` lines below are erased by the compiler, so the only runtime edges
// into those chunks are the `import()` calls inside the mounts.
//
// ONE MODULE FOR BOTH, AND TWO CHUNKS INSIDE IT. The bar has exactly two disclosed acts
// and one file is where a reader meets both of them beside each other; what is
// deliberately NOT shared is the chunk. A single root re-exporting both would make
// pressing Join fetch the import panel, its progress line, and the four stream arms that
// panel renders — code for an act that press is not, charged to it because the two lines
// happened to live in one module. Two roots, two `import()` calls, two memos.
//
// A `LoadedLazyBody` EACH rather than a `lazy()` of this module's own, because that
// class is already the console's one answer to a loader-backed body: one in-flight
// promise however many callers ask, one component identity so a host re-render does not
// remount a half-typed form, a fresh payload only where a load rejected so the error
// boundary's retry reaches a live loader, and the settled body rendered directly once
// the chunk has landed — so a form disclosed, dismissed, and disclosed again never
// suspends at all.
//
// TWO `const`s AND NOT MODULE-LEVEL `let`s: the memo is each class's own private field,
// which is what `apps/desktop/AGENTS.md` §State and views asks for, and a window has one
// acts bar per sessions destination with nothing to key a registration on.
//
// WHAT A PENDING BODY DRAWS is the marker `seats/pane/pending-pane-body.ts` owns and nothing
// else: no spinner, no skeleton, and none of rule 8's five kinds of nothing. What is
// absent is a MODULE rather than anything about the act, and the marker rides a `hidden`
// element, so what the wait costs the layout is nothing and the screenshot tier refuses
// to photograph a tree still carrying one.

import { LoadedLazyBody, reservedBodyRegion } from "../../seats/index.js";
import type { JoinSessionFormProps } from "./JoinSessionForm.js";
import type { ProviderImportPanelProps } from "./ProviderImportPanel.js";

/**
 * What a pending join form stamps, so a refused capture says WHICH body was loading.
 *
 * Not a pane kind — neither of these bodies is a pane, and both are drawn inside a bar
 * the deck knows nothing about — so the value is the body's own name.
 */
const JOIN_SESSION_FORM_PENDING_BODY = "join-session-form";

/** The same, for the import panel: two names, so a refusal names one of them. */
const PROVIDER_IMPORT_PANEL_PENDING_BODY = "provider-import-panel";

/** The join form, mounted from its own chunk. The Join disclosure's one reader. */
export const joinSessionFormMount: LoadedLazyBody<JoinSessionFormProps> = new LoadedLazyBody(
  () => import("./join-session-form-body.js"),
  () => reservedBodyRegion(JOIN_SESSION_FORM_PENDING_BODY),
);

/** The import panel, mounted from its own chunk. The create menu's one reader. */
export const providerImportPanelMount: LoadedLazyBody<ProviderImportPanelProps> =
  new LoadedLazyBody(
    () => import("./provider-import-panel-body.js"),
    () => reservedBodyRegion(PROVIDER_IMPORT_PANEL_PENDING_BODY),
  );
