// Barrel for the git-flow contract; the package root re-exports it. `shared.ts` is not
// re-exported: its scalars are building blocks of the public schemas. Modules import in one
// direction, shared <- hosting <- local <- methods, and each holds eager module-scope Zod
// schemas, so the chain must stay acyclic.
export * from "./hosting.js";
export * from "./local.js";
export * from "./methods.js";
