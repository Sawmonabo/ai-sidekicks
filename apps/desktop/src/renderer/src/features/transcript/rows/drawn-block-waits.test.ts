// What a message row's streaming tail starts before its blocks settle: the diagram worker, for a
// diagram fence the tail opens on a complete line, whatever ending its lines take.

import { expect, it, vi } from "vitest";

import { DrawnBlockWaits } from "./drawn-block-waits.js";
import type { TranscriptRowSources } from "./renderer.js";

it.each([
  { lineEnding: "\n", name: "a line feed" },
  { lineEnding: "\r", name: "a carriage return" },
  { lineEnding: "\r\n", name: "both" },
])(
  "starts the diagram worker for a diagram fence a tail opens, its lines ending in $name",
  ({ lineEnding }) => {
    const startWorker = vi.fn();
    // The row reads only the pictures' worker and its window to start what an open fence waits on.
    const sources = {
      ownerWindow: window,
      diagramPictures: { startWorker },
    } as unknown as TranscriptRowSources;
    const waits = new DrawnBlockWaits(
      "row",
      sources,
      () => () => undefined,
      () => undefined,
    );
    const tail = `Intro.${lineEnding}${lineEnding}\`\`\`mermaid${lineEnding}graph TD`;

    waits.startLoadsForOpenFences(1, tail.length, tail);

    expect(startWorker).toHaveBeenCalledTimes(1);
  },
);
