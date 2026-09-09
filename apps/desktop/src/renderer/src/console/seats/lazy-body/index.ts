// The lazy-body sub-module's door: the two names the pane and surface registries take.
//
// `pane/pane-registry.ts` and `surface/surface-registry.ts` both resolve a
// loader-backed body, and both take exactly `LoadedLazyBody` and `LazyBodyLoader`.
// Everything else here — the warm scheduler, the focus handoff, the React bodies —
// is read by this directory and by the family door, which reaches each declaring
// module directly.
export { LoadedLazyBody, type LazyBodyLoader } from "./lazy-body.js";
