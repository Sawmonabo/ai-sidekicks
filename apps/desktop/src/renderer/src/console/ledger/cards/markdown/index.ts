// The markdown pipeline's door.
//
// A MODULE DIRECTORY RATHER THAN A FLAT PILE, on `apps/desktop/AGENTS.md`'s terms: the
// segmenter, the parse, the mapper, the two renderers, the footnote pair, and the
// highlighter are seven jobs, and seven files beside `MessageCard.tsx` would be a pile.
// They are one module because they are useless apart — a segmenter with no parse decides
// nothing, and a mapper with no segmenter re-parses the world.
//
// THIS IS NOT A CONSOLE FAMILY DOOR. `ledger/cards/index.ts` is the ledger cards' one
// barrel; this is an intra-family module boundary one level below it, so nothing outside
// `cards/` imports through here. Named rather than starred, so the census can enumerate
// what the pipeline publishes: the highlighter, the code theme, the worker protocol and
// the caches are the pipeline's own internals and stop at this line.

export { FootnotePopoverHost } from "./FootnotePopoverHost.js";
export { MarkdownNodes, type MarkdownRenderContext } from "./MarkdownNodes.js";
export { MarkdownBlockSegmenter } from "./block-segmenter.js";
export { measureUtf8ByteLength } from "./byte-bounded-cache.js";
export { collectFootnoteDefinitions, collectFootnoteReferences } from "./footnote-collection.js";
export { FootnoteRegistry } from "./footnote-registry.js";
export {
  footnoteDefinitionPreamble,
  parseSettledBlock,
  parseVolatileTail,
} from "./markdown-parse.js";
