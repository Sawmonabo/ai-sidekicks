// The provider-import panel's chunk root: the one module an `import()` names.
//
// The panel is absent until a person asks for it, so it stays off the initial import graph.
// A symbol reachable both statically and dynamically lands in the static chunk, so this
// module is the split point. Only the panel and `ImportProgressLine.tsx` defer: the import
// itself lives in `useProviderImport.ts`, above whatever discloses the panel, because a
// model deferred with its view would lose an import nobody can see.
//
// Named `Body` because `components/LazyBody/loader.ts` fixes the export name a loader
// resolves.

export { ProviderImportPanel as Body } from "../ProviderImportPanel.js";
