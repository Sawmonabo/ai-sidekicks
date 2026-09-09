// The file-restore disclosure as the door publishes it: the same body, with the module
// that draws it fetched first.
//
// WHY THIS MODULE EXISTS AT ALL. The primitives door is on the console's initial import
// graph — the renderer root reaches it — so every value the door NAMES is charged to
// every launch. `FileRestoreDisclosure`'s only production reader is
// `runs/pane/controls/RollbackDisclosure.tsx`, inside a pane that is loader-backed
// already, so the door line did exactly what `apps/desktop/AGENTS.md` §Module shape warns
// a door line for a lazily-read body does: a symbol reachable both statically and
// dynamically is assigned to the STATIC chunk, and the disclosure rode the document of
// every session that never rewinds anything.
//
// SO THE DOOR NAMES THIS, AND THIS NAMES THE WORK THROUGH `import()`. What stays on the
// graph is one function body and a type reference that erases; the disclosure, its two
// enumeration lists, the windowed path list, the cell, and `restore.css` are emitted as
// their own chunk and fetched the first time a settled rollback discloses a working tree.
// `bridge/wire-shapes/json-schema-check-loader.ts` is the same move for the schema
// compiler, and it is the precedent this follows rather than a second shape beside it.
//
// AND THE DEFERRAL IS HERE RATHER THAN IN THE CALLER. A view family may not reach past
// this family's door, which `console-cross-family-deep-import` closes, so the runs pane
// cannot `import()` the component's module itself. The wrapper belongs on this side of
// the door, which is also where the reason for it is legible: the door's own eagerness is
// what has to be paid for.
//
// THE RETURN TYPE IS SPELLED STRUCTURALLY RATHER THAN NAMED, and that is the layering
// rule and not a preference. `seats/lazy-body.ts` declares `LazyBodyModule`, and `seats/`
// sits ABOVE `primitives/` on the console DAG — so naming it here would be an upward edge
// `structure:layering` fails, for a type that erases. What is written below is that
// contract's shape, which is what the caller's `LoadedLazyBody` accepts; the pairing is
// held by the compiler at the call site rather than by an import that may not exist.
//
// NO MEMO IS KEPT BESIDE IT: the module map is already the memo, and the caller's
// `LoadedLazyBody` holds the component identity a React host reconciles by. A second
// cache here would be a class written for a caller that already has one.

import type { FileRestoreDisclosureProps } from "./FileRestoreDisclosure.js";

/**
 * Fetch the disclosure's chunk, and hand back the module the caller mounts from.
 *
 * The MODULE and not a rendered element, because what a loader-backed body needs is a
 * component identity that survives its host's re-renders — which is `LoadedLazyBody`'s
 * job on the other side of the door, and which a wrapper returning elements would take
 * away from it.
 */
export async function loadFileRestoreDisclosure(): Promise<{
  readonly Body: (props: FileRestoreDisclosureProps) => React.ReactNode;
}> {
  return import("./file-restore-disclosure-body.js");
}
