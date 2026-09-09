// The markdown pipeline's door.
//
// A MODULE DIRECTORY RATHER THAN A FLAT PILE, on `apps/desktop/AGENTS.md`'s terms: four
// sub-modules sit under this door — `parse/` (the segmenter, the parse, and the byte-bounded
// cache both of them charge against), `nodes/` (the mapper, its rendering rules, and the
// math node), `footnotes/` (the registry, the collection, the popover host and the three
// bodies it renders), and `highlight/` (the code block, the tokenizer, the worker and its
// protocol, the language set, and the code theme). They are one module because they are
// useless apart — a segmenter with no parse decides nothing, and a mapper with no segmenter
// re-parses the world. The count is named by the sub-modules rather than restated as a
// number, so it cannot go stale the way §Module shape warns a roster does.
//
// NONE OF THE FOUR CARRIES A DOOR OF ITS OWN, and that is what keeps the sheet where it is.
// §Module shape: a directory owns its own sub-directories that carry no `index.ts`, so
// `markdown.css` stays the property of this directory and enters through this line. It is
// also what keeps the graph acyclic: a footnotes/index.ts would publish both
// `FootnoteReference` (which `nodes/MarkdownNodes.tsx` reads) and `FootnotePopoverHost`
// (which reads `nodes/MarkdownNodes.tsx`), and a door is an edge to everything it
// re-exports — `no-circular` fails on that triangle. Each group is read from outside itself
// by one named module, which a deep intra-family specifier already gives.
//
// THIS IS NOT A CONSOLE FAMILY DOOR. `ledger/cards/index.ts` is the ledger cards' one
// barrel; this is an intra-family module boundary one level below it, so nothing outside
// `cards/` imports through here. Named rather than starred, so the census can enumerate
// what the pipeline publishes: the highlighter, the code theme, the worker protocol and
// the caches are the pipeline's own internals and stop at this line.

// The sheet this module owns, imported by its own door.
import "./markdown.css";

export { FootnotePopoverHost } from "./footnotes/FootnotePopoverHost.js";
export { MarkdownNodes, type MarkdownRenderContext } from "./nodes/MarkdownNodes.js";
export { MarkdownBlockSegmenter } from "./parse/block-segmenter.js";
export {
  collectFootnoteDefinitions,
  collectFootnoteReferences,
} from "./footnotes/footnote-collection.js";
export { FootnoteRegistry } from "./footnotes/footnote-registry.js";
export {
  footnoteDefinitionPreamble,
  parseSettledBlock,
  parseVolatileTail,
} from "./parse/markdown-parse.js";
