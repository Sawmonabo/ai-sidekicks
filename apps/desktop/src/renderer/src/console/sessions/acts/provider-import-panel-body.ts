// The provider-import panel's chunk root: the one module an `import()` names.
//
// WHY IT EXISTS. Importing a provider thread is the acts bar's THIRD act and the one
// furthest from the screen's own question: it lives inside the create menu, so reaching
// it is a press to open the menu and a press to choose the item, and the panel is absent
// from the tree until both have happened. `apps/desktop/AGENTS.md` §Module shape decides
// the form by asking whether a body is painted before a person acts, and this one is
// not — on any launch, including every launch that never opens that menu.
//
// It rode the initial import graph anyway, because `SessionActs.tsx` named the panel by
// static import, and a symbol reachable both statically and dynamically is assigned to
// the STATIC chunk — which put the panel and `ImportProgressLine.tsx` beside it on the
// document every session downloads. The bar now reaches the panel through
// `act-body-mounts.ts`, and this module is the split point.
//
// WHAT STAYS EAGER, AND WHY IT IS NOT ARBITRARY. The IMPORT itself does.
// `provider-import-model.ts` states the defect that put it there: held one level down,
// an import lost its progress subscription the moment somebody switched to the join
// form, so `SessionActs` holds the model unconditionally and this panel is a VIEW over
// an import rather than the place one lives. A model deferred with its view would be
// that defect again, one chunk further out — an import a person cannot see because the
// module that would report it has not been fetched.
//
// So what defers is exactly the two components nothing eager renders: the panel and the
// progress line it draws. `session-acts.css` stays on the sessions family door, which
// owns it and dresses the bar the destination paints.
//
// Named `Body` because `seats/lazy-body.ts` fixes the export name a loader resolves.

export { ProviderImportPanel as Body } from "./ProviderImportPanel.js";
