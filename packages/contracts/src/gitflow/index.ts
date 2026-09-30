// Barrel for the git-flow contract in `packages/contracts/src/gitflow/`. The package
// root re-exports it, so consumers import from `@ai-sidekicks/contracts`.
//
// `shared.ts` is not re-exported: its scalars are building blocks of the public
// schemas. Module order is the one-way import chain, shared <- hosting <- local <-
// methods; each module holds eager module-scope zod schemas, so the chain stays acyclic.
export * from "./hosting.js";
export * from "./local.js";
export * from "./methods.js";
