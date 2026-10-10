import type { FootnoteDefinition } from "mdast";
import { useEffect, useRef } from "react";

import { collectFootnoteDefinitions } from "#renderer/components/Markdown/footnotes/collection.js";
import { parseSettledBlock } from "#renderer/components/Markdown/parse.js";
import { type MarkdownBodyBlocksSnapshot } from "../../markdown/body-blocks.js";
import { type FootnoteRegistry } from "../../markdown/footnotes/registry.js";

/**
 * Records every footnote definition one body declares, drawn or not, from an effect so no render
 * writes the registry. A settled block's definitions are read against the whole body's, once per
 * block and preamble; the tail's are read from the tail alone, on the frames that hold one.
 */
export function useFootnoteDefinitionRegistration(
  blocks: MarkdownBodyBlocksSnapshot,
  footnotes: FootnoteRegistry,
  sourceId: string,
): void {
  const { definingBlocks, definitionPreamble, volatileTailDefinitions, readBlockSource } = blocks;
  const registered = useRef<RegisteredBlocks | undefined>(undefined);
  useEffect(() => {
    let held = registered.current;
    if (
      held?.footnotes !== footnotes ||
      held.sourceId !== sourceId ||
      held.definitionPreamble !== definitionPreamble
    ) {
      held = { footnotes, sourceId, definitionPreamble, blockKeys: new Set() };
      registered.current = held;
    }
    for (const block of definingBlocks) {
      if (held.blockKeys.has(block.key)) {
        continue;
      }
      held.blockKeys.add(block.key);
      const nodes = parseSettledBlock(readBlockSource(block), definitionPreamble).children;
      register(collectFootnoteDefinitions(nodes).definitions, footnotes, sourceId);
    }
    register(volatileTailDefinitions, footnotes, sourceId);
  }, [
    definingBlocks,
    definitionPreamble,
    volatileTailDefinitions,
    readBlockSource,
    footnotes,
    sourceId,
  ]);
}

/** The blocks registered into one registry for one source under one preamble. */
interface RegisteredBlocks {
  readonly footnotes: FootnoteRegistry;
  readonly sourceId: string;
  readonly definitionPreamble: string;
  readonly blockKeys: Set<string>;
}

function register(
  definitions: readonly FootnoteDefinition[],
  footnotes: FootnoteRegistry,
  sourceId: string,
): void {
  for (const definition of definitions) {
    footnotes.register({
      sourceId,
      identifier: definition.identifier,
      bodyNodes: definition.children,
    });
  }
}
