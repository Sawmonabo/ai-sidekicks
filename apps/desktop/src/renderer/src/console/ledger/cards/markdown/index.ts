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
// `cards/` imports through here. The star form is `ledger/frame/index.ts`' — every
// consumer is a sibling piece of this same task, so a named barrel would be a list of
// findings and a `@consumedBy` tag would name the task that already owns the file.
//
// The comment on each line is the table a named barrel would have been: what the module
// carries, in dependency order, low to high.

export * from "./byte-bounded-cache.js"; // the byte bound both caches spend
export * from "./meridian-code-theme.js"; // the token families, and the theme that emits them
export * from "./code-tokenizer.js"; // one shiki core per realm, and the grammar table
export * from "./highlight-protocol.js"; // the two messages the worker boundary carries
export * from "./highlight-scheduler.js"; // where a block is tokenised, and where it is kept
export * from "./markdown-parse.js"; // micromark + mdast, once per settled block
export * from "./block-segmenter.js"; // committed prefix, volatile tail
export * from "./footnote-registry.js"; // definitions, keyed by source
export * from "./footnote-collection.js"; // finding them without rendering them
export * from "./CodeBlock.js"; // the own span renderer
export * from "./MathBlock.js"; // the one dangerouslySetInnerHTML site
export * from "./MarkdownNodes.js"; // the mapper
