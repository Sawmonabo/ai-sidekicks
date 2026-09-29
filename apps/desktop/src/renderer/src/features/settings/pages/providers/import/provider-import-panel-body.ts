// The provider-import panel's chunk root: the one module an `import()` names.
//
// WHY IT EXISTS. Importing a provider thread is the least common way work arrives, and
// its panel is absent from the tree until a person asks for it. The module-shape rule in
// `apps/desktop/AGENTS.md` decides the form by asking whether a body is painted before a
// person acts, and this one is not — on any launch, including every launch that never
// opens the panel.
//
// A symbol reachable both statically and dynamically is assigned to the STATIC chunk, so
// a static import of the panel would put it and `ImportProgressLine.tsx` beside it on the
// document every session downloads. The mount in `act-body-mounts.ts` reaches the panel
// through this module, and this module is the split point.
//
// WHAT STAYS EAGER, AND WHY. The import itself does. `provider-import-model.ts` holds an
// import above whatever discloses the panel, so the panel is a VIEW over an import rather
// than the place one lives. A model deferred with its view would lose an import a person
// cannot see, because the module that would report it has not been fetched. So what
// defers is exactly the two components nothing eager renders: the panel and the progress
// line it draws.
//
// Named `Body` because `seats/lazy-body/lazy-body.ts` fixes the export name a loader resolves.

export { ProviderImportPanel as Body } from "./ProviderImportPanel.js";
