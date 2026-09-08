// The definition detail's door: what the builder pane mounts once it has a definition.
//
// A SUB-MODULE DOOR AND NOT A FAMILY DOOR — the rule `apps/desktop/AGENTS.md` states
// and `bridge/growth-values/index.ts` is the precedent for. It publishes to this family
// only, it is reached by one deep intra-family specifier from `pane/builder/`, and the
// family door above re-exports nothing from it.
//
// IT EXISTS BECAUSE A SIBLING TAKES FROM IT. The definitions directory is the browser's
// and this is what a browser row opens; the pane that mounts it lives under `pane/`,
// which is a sibling rather than a resident. A directory no sibling reached would carry
// no door at all.
//
// THE SHEET ENTERS HERE, which is the barrel of the directory that owns it. Nothing
// above this door renders these rules, and the door is reached only from the builder
// pane's own lazily-loaded chunk — so the sheet travels with the pane a person opened
// rather than sitting on every session's initial document.

import "./definition-detail.css";

export { DefinitionDetail } from "./DefinitionDetail.js";
