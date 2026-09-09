// The `when` clause: its context shape, its parser, the cache the registry evaluates
// through, and the overlap comparison the binding table refuses conflicts with.
//
// A SUB-MODULE DOOR, published to `palette/` alone. Three siblings earn it —
// `commands/command-registry.ts` evaluates a clause per command through the cache,
// `keybindings/keybinding-conflicts.ts` parses and overlaps two of them, and
// `overlay/` types its scope by the context — so the directory folds one wire for
// each of them rather than four.
//
// `palette/index.ts` publishes `WhenClauseContext` from `when-clause.ts` itself,
// because a family door re-exports from the module that DECLARES a symbol and never
// through an inner barrel.
export {
  collectWhenClauseIdentifiers,
  evaluateWhenClause,
  formatWhenClause,
  type WhenClauseContext,
  type WhenClauseNode,
} from "./when-clause.js";
export { WhenClauseCache } from "./when-clause-cache.js";
export { whenClausesCanOverlap } from "./when-clause-overlap.js";
export { parseWhenClause, type WhenClauseParseError } from "./when-clause-parser.js";
