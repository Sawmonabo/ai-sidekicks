// What a message row waits on before the feed lists it, against stand-in diagram workers: a
// diagram that cannot be drawn still lets the row go, into the failure its body draws; and a
// listed reply whose live text settles a diagram has the picture asked for before anything mounts
// it; a reply's stored body takes over from its retired lane, settling its last block; and a
// streaming formula or diagram fence starts its typesetter or worker once it names its language,
// while a fence of code starts neither.

import { describe, expect, it, vi } from "vitest";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { DiagramPictures } from "#renderer/components/Markdown/diagram/pictures.js";
import { FakeDiagramWorkers } from "#renderer/components/Markdown/diagram/worker/connection.test-support.js";
import { typesetterLoadFor } from "#renderer/components/Markdown/typesetter/load.js";
import { userMessageRow } from "../event-rows.test-support.js";
import { transcriptReadRowAt } from "../logs.test-support.js";
import { RevealTextRope } from "../reveal/text-rope.js";
import { prepareTranscriptRow } from "./preparation.js";
import { OffListTables } from "./markdown/table-window/off-list.js";
import { type TranscriptRowSources } from "./renderer.js";

/** A share far larger than these cases draw. */
const CACHE_BYTE_CAP = 16 * 1024 * 1024;

/** A flowchart with a node left open, which merman refuses. */
const REFUSED_DIAGRAM = "flowchart TD\n  A --> B\n  B --> [Fix it";

const SETTLED_DIAGRAM = "flowchart LR\n  write --> store";

function sourcesWith(
  pictures: DiagramPictures,
  publishedTextFor: TranscriptRowSources["publishedTextFor"] = () => undefined,
): TranscriptRowSources {
  return {
    publishedTextFor,
    ownerWindow: window,
    diagramPictures: pictures,
    offListTables: new OffListTables(document, () => undefined),
  };
}

/** Publish `text` on the lane whole, as one drained frame does. */
function revealInto(laneText: RevealTextRope, text: string): void {
  laneText.append(text);
  laneText.advance(text.length);
}

function sentSources(workers: FakeDiagramWorkers): string[] {
  return workers.started.flatMap((worker) => worker.requests.map((request) => request.source));
}

/** A reply row, with the stored body `content` when given. */
function replyRow(content?: TranscriptEventRow["content"]): TranscriptEventRow {
  const message = transcriptReadRowAt(0);
  return message.kind === "general"
    ? { ...message, type: "assistant.message", ...(content === undefined ? {} : { content }) }
    : expect.fail("a message row is a general row");
}

/** A window of its own, whose document no typesetter load has started in. */
function freshWindow(): Window {
  return (
    document.body.appendChild(document.createElement("iframe")).contentWindow ??
    expect.fail("an attached frame has a window")
  );
}

describe("a message row's preparation", () => {
  it("lets the row go once its diagram's drawing fails, into the failure the body draws", async () => {
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, workers.start, () => undefined);
    const row = userMessageRow({
      id: "message",
      sequence: 0,
      message: `Here it is:\n\n\`\`\`mermaid\n${REFUSED_DIAGRAM}\n\`\`\`\n`,
    });
    const onReady = vi.fn();

    const preparation = prepareTranscriptRow(row, sourcesWith(pictures), onReady);
    expect(preparation?.isReady).toBe(false);
    await vi.waitFor(() => {
      expect(sentSources(workers)).toEqual([REFUSED_DIAGRAM]);
    });
    workers.latest().load();
    workers.latest().answer({ kind: "failed", reason: "Parse error on line 3" });

    await vi.waitFor(() => {
      expect(onReady).toHaveBeenCalledTimes(1);
    });
    expect(preparation?.isReady).toBe(true);
  });

  it("asks for a listed reply's newly settled diagram before anything mounts it", async () => {
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, workers.start, () => undefined);
    const laneText = new RevealTextRope("reply");
    revealInto(laneText, "Here is the plan.\n\n");
    const preparation = prepareTranscriptRow(
      replyRow(),
      sourcesWith(pictures, () => laneText),
      () => undefined,
    );
    await Promise.resolve();
    expect(sentSources(workers)).toEqual([]);

    // The fence settles once the blocks after it are complete past the segmenter's lag.
    revealInto(
      laneText,
      `\`\`\`mermaid\n${SETTLED_DIAGRAM}\n\`\`\`\n\nFirst step.\n\nSecond step.\n\nThird step.\n\n`,
    );
    preparation?.refresh();
    preparation?.refresh();
    await vi.waitFor(() => {
      expect(sentSources(workers)).toEqual([SETTLED_DIAGRAM]);
    });
    expect(preparation?.isReady).toBe(false);
  });

  it("reads a reply's stored body once its lane retires, settling the diagram that ends it", async () => {
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, workers.start, () => undefined);
    const body = `Here is the plan.\n\n\`\`\`mermaid\n${SETTLED_DIAGRAM}\n\`\`\`\n`;
    let laneText: RevealTextRope | undefined = new RevealTextRope("reply");
    revealInto(laneText, body);
    const preparation = prepareTranscriptRow(
      replyRow({ status: "available", body }),
      sourcesWith(pictures, () => laneText),
      () => undefined,
    );
    preparation?.refresh();
    await Promise.resolve();
    // Still streaming, the fence that ends the lane's text has not settled.
    expect(sentSources(workers)).toEqual([]);

    laneText = undefined;
    preparation?.refresh();
    await vi.waitFor(() => {
      expect(sentSources(workers)).toEqual([SETTLED_DIAGRAM]);
    });
    expect(preparation?.isReady).toBe(false);
  });

  it("starts the typesetter and the diagram worker once a streaming fence names its language", () => {
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, workers.start, () => undefined);
    const ownerWindow = freshWindow();
    const laneText = new RevealTextRope("reply");
    revealInto(laneText, "The sum:\n\n```math\n\\sum_{i=1}^{n} i");
    const preparation = prepareTranscriptRow(
      replyRow(),
      { ...sourcesWith(pictures, () => laneText), ownerWindow },
      () => undefined,
    );
    expect(typesetterLoadFor(ownerWindow.document).isStarted).toBe(true);
    // The formula is still streaming, so the row waits on nothing.
    expect(preparation?.isReady).toBe(true);

    // A language not yet followed by its line's end may still grow into another word.
    revealInto(laneText, "\n```\n\nThe flow:\n\n```mermaid");
    preparation?.refresh();
    expect(workers.started).toHaveLength(0);
    revealInto(laneText, "\nflowchart LR\n  write -->");
    preparation?.refresh();
    expect(workers.started).toHaveLength(1);
    expect(sentSources(workers)).toEqual([]);
  });

  it("starts neither for a streaming reply whose fences are code", () => {
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, workers.start, () => undefined);
    const ownerWindow = freshWindow();
    const laneText = new RevealTextRope("reply");
    revealInto(laneText, "The math and the mermaid:\n\n```ts\nconst mathematics = mermaid;\n");
    const preparation = prepareTranscriptRow(
      replyRow(),
      { ...sourcesWith(pictures, () => laneText), ownerWindow },
      () => undefined,
    );
    revealInto(laneText, "```\n\n```mathematica\nSum[i, {i, 1, n}]\n");
    preparation?.refresh();

    expect(typesetterLoadFor(ownerWindow.document).isStarted).toBe(false);
    expect(workers.started).toHaveLength(0);
  });
});
