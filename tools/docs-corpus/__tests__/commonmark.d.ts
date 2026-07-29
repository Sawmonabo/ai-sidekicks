// Minimal ambient declaration for the commonmark reference parser.
//
// The package ships no types of its own, and DefinitelyTyped's
// `@types/commonmark` is pinned at 0.27.x against the 0.31.2 this repo depends
// on — four minor versions of drift describing an API we would then be
// trusting blind. So this declares ONLY the members the corroboration test
// reads, each one verified against the installed 0.31.2 source rather than
// assumed:
//
//   sourcepos  A public getter (`lib/node.js`), populated unconditionally: the
//              block parser writes `block.sourcepos` with no options gate
//              anywhere in `lib/blocks.js`, so a bare `new Parser()` is enough
//              and the `{ sourcepos: true }` option is not needed.
//   info       Initialized to `null` (`lib/node.js`) and assigned in exactly
//              one place — the FENCED branch of `code_block.finalize`
//              (`lib/blocks.js`). That makes `info !== null` a public
//              fencedness discriminator, which is why nothing here reads the
//              private `_isFenced` flag the parser uses internally.
//
// Both facts are pinned by assertions in `commonmark-oracle.test.ts`: this
// declaration is a claim about the dependency, so the suite proves it rather
// than trusting the comment.
declare module "commonmark" {
  export interface CommonMarkNode {
    /** Block/inline type — `"code_block"` is the only one read here. */
    readonly type: string;
    /** `[[startLine, startColumn], [endLine, endColumn]]`, all 1-based. */
    readonly sourcepos: [[number, number], [number, number]];
    /** Info string for FENCED code blocks; `null` for every other block. */
    readonly info: string | null;
    readonly literal: string | null;
    walker(): NodeWalker;
  }

  export interface NodeWalker {
    next(): { entering: boolean; node: CommonMarkNode } | null;
  }

  export class Parser {
    constructor(options?: { sourcepos?: boolean });
    parse(input: string): CommonMarkNode;
  }
}
