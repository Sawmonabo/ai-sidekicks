// The parser's calls a thread runs once Sätteri's loader has its compiled module: the tree a text
// parses to, and where a text's top-level children sit. Imported lazily, on chunks of their own,
// after the module is set where the loader reads it, by the page's parser and the markdown worker.

/** The parser's calls, once the module they run on is loaded. */
export interface MarkdownParserCalls {
  readonly serializer: typeof import("./serialized-tree.js");
  readonly children: typeof import("./top-level-children.js");
}

/** Imports the parser's calls and warms the parser up on a short reply. */
export async function loadMarkdownParserCalls(): Promise<MarkdownParserCalls> {
  const childrenLoad = import("./top-level-children.js");
  const serializer = await import("./serialized-tree.js");
  serializer.warmUpMarkdownParser();
  return { serializer, children: await childrenLoad };
}
