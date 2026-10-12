import type { FootnoteDefinition } from "mdast";
import { useEffect, useRef, useState } from "react";

import { collectFootnoteDefinitions } from "#renderer/components/Markdown/footnotes/collection.js";
import { appMarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { type MarkdownBodyBlocksSnapshot } from "../../markdown/body-blocks.js";
import { type FootnoteRegistry } from "../../markdown/footnotes/registry.js";

/**
 * Records every footnote definition one body declares, drawn or not, from an effect so no render
 * writes the registry. A settled block's definitions are read against the whole body's, once per
 * block and preamble, as its parse lands; the tail's are read from the tail alone, on the frames
 * that hold one. A failed parse throws, for the row's error boundary.
 */
export function useFootnoteDefinitionRegistration(
  blocks: MarkdownBodyBlocksSnapshot,
  footnotes: FootnoteRegistry,
  sourceId: string,
): void {
  const { definingBlocks, definitionPreamble, volatileTailDefinitions, readBlockSource } = blocks;
  const registered = useRef<RegisteredBlocks | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
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
    const readsInFlight: Unsubscribe[] = [];
    for (const block of definingBlocks) {
      if (held.blockKeys.has(block.key)) {
        continue;
      }
      const blockKeys = held.blockKeys;
      readsInFlight.push(
        appMarkdownTrees.requestSettledBlock(
          readBlockSource(block),
          definitionPreamble,
          (outcome) => {
            if (outcome.status === "failed") {
              setFailure(outcome.reason);
              return;
            }
            blockKeys.add(block.key);
            const { definitions } = collectFootnoteDefinitions(outcome.root.children);
            register(definitions, footnotes, sourceId);
          },
        ),
      );
    }
    register(volatileTailDefinitions, footnotes, sourceId);
    return () => {
      for (const stop of readsInFlight) {
        stop();
      }
    };
  }, [
    definingBlocks,
    definitionPreamble,
    volatileTailDefinitions,
    readBlockSource,
    footnotes,
    sourceId,
  ]);
  if (failure !== undefined) {
    throw new Error(failure);
  }
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
