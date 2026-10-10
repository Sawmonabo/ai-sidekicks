// The diff card's browser suites: a card drawn in a scrolling flow of a known size, and the
// patches and models the cases draw it from.

import { render } from "@testing-library/react";

import {
  TranscriptBodyViewportContext,
  type TranscriptBodyViewport,
} from "#renderer/components/TranscriptBodyViewport/context.js";
import type { DiffInlineCardProps } from "#renderer/registries/inline-cards/registry.js";
import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import type { DiffModel } from "../model.js";
import { parseUnifiedPatch } from "../patch-parse.js";
import { InlineDiffCard } from "./InlineDiffCard.js";

/** A row's card props, naming no compared pair. */
export const DIFF_CARD: DiffInlineCardProps = {
  kind: "diff",
  runId: "run-1",
  diffArtifactId: "diff-artifact-1",
  artifactManifestId: "artifact-manifest-1",
};

/** The flow a card is drawn in, and the card and its first block. */
export interface DrawnDiffCard {
  readonly flow: HTMLElement;
  readonly card: HTMLElement;
  readonly block: HTMLElement;
}

/**
 * Draw the card, in a document whose tokens the suite installed, in a flow of `heightPx` by
 * `widthPx` that scrolls, inside `viewport` where one is
 * given, and hand back the flow, the card and its first block.
 */
export function drawDiffCard(
  diff: DiffModel,
  options: {
    readonly heightPx: number;
    readonly widthPx: number;
    readonly card?: DiffInlineCardProps;
    readonly viewport?: TranscriptBodyViewport;
  },
): DrawnDiffCard {
  const BridgeHost = liveBridgeWrapper();
  const card = <InlineDiffCard card={options.card ?? DIFF_CARD} diff={diff} />;
  const { container } = render(
    <BridgeHost>
      <div
        data-flow=""
        // The conversation's own scroll anchoring is off, so the browser's is too.
        style={{
          blockSize: options.heightPx,
          inlineSize: options.widthPx,
          overflowY: "auto",
          overflowAnchor: "none",
        }}
      >
        {options.viewport === undefined ? (
          card
        ) : (
          <TranscriptBodyViewportContext value={options.viewport}>
            {card}
          </TranscriptBodyViewportContext>
        )}
      </div>
    </BridgeHost>,
  );
  const flow = container.querySelector<HTMLElement>("[data-flow]");
  const drawnCard = container.querySelector<HTMLElement>(".meridian-diff-card");
  const block = drawnCard?.querySelector<HTMLElement>(".meridian-diff-block");
  if (flow === null || drawnCard === null || block === null || block === undefined) {
    throw new Error("the card drew no block");
  }
  return { flow, card: drawnCard, block };
}

/** One file's patch: its headers, then each hunk header followed by its prefixed lines. */
export function filePatch(path: string, ...hunks: readonly (string | readonly string[])[]): string {
  const lines = [`--- ${path}`, `+++ ${path}`];
  for (const hunk of hunks) {
    lines.push(...(typeof hunk === "string" ? [hunk] : hunk));
  }
  return [...lines, ""].join("\n");
}

/** The diff of the given file patches, each file carrying its own patch for `Copy patch`. */
export function diffOf(filePatches: readonly string[]): DiffModel {
  const files = filePatches.map((patch) => {
    const parsed = parseUnifiedPatch(patch, { baseRef: "main", headRef: "feature" });
    const [file] = parsed.files;
    if (file === undefined) {
      throw new Error("a test patch parsed to no file");
    }
    return { ...file, patch };
  });
  return { baseRef: "main", headRef: "feature", files };
}
