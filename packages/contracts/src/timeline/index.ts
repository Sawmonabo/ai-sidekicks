// Plan-013 Phase 1 — barrel for the `packages/contracts/src/timeline/`
// subdirectory registered to Plan-013 in
// `docs/architecture/cross-plan-dependencies.md §2. Package Path Ownership Map`.
//
// The package keeps exporting only `"."`, so consumers import from
// `@ai-sidekicks/contracts`; this barrel is re-exported from
// `packages/contracts/src/index.ts` per the repo's single-import-surface
// convention (the Plan-021 T21.1-1 / T21.1-2 precedent the ownership row
// names).
//
// Module order below is the subdirectory's one-way import chain —
// child-run-summary ← row ← operations ← methods. Every module here is an
// eager module-scope Zod initializer, so keeping the chain acyclic is what
// prevents a `ReferenceError` at import time.
export * from "./child-run-summary.js";
export * from "./row.js";
export * from "./operations.js";
export * from "./methods.js";
