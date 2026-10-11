// What the markdown worker makes for each request, on whichever thread runs it: the worker's own in
// the app, the test's where no worker runs. Requests are answered as they come, a drawn part's
// waiting on the page for each answer to its asks for undrawn rows while the next request starts.

import type { TableRow } from "mdast";

import { decodeTextPieces, encodeTextPieces } from "#renderer/lib/text-pieces.js";
import { describeFailure } from "#shared/failure-message.js";
import { drawnTreeMarkdown, drawnTreeText } from "../drawn-text.js";
import { markdownToHtml } from "../html.js";
import type {
  MarkdownWorkerMade,
  MarkdownWorkerMessage,
  MarkdownWorkerReply,
  MarkdownWorkerRequest,
} from "./messages.js";

/** The worker's side of its talk with the page, sending each reply through `send`. */
export class MarkdownWorkerAnswers {
  readonly #send: (reply: MarkdownWorkerReply, transfer: readonly Transferable[]) => void;
  /** Takes the page's answer to each request's unanswered ask for rows, by the request's id. */
  readonly #asks = new Map<number, (rows: readonly string[]) => void>();

  /** `send` posts a reply to the page, moving the buffers in `transfer`. */
  public constructor(
    send: (reply: MarkdownWorkerReply, transfer: readonly Transferable[]) => void,
  ) {
    this.#send = send;
  }

  /**
   * Starts answering a request, or hands rows to the ask waiting on them. Throws for rows no ask
   * waits on, which only a page out of step with the worker sends.
   */
  public hear(message: MarkdownWorkerMessage): void {
    if (message.kind !== "undrawn-rows") {
      void this.#answer(message);
      return;
    }
    const take = this.#asks.get(message.requestId);
    if (take === undefined) {
      throw new Error("The page sent rows the markdown worker did not ask for.");
    }
    this.#asks.delete(message.requestId);
    take(message.rows);
  }

  /** Sends what `request` comes to: what was made, or why nothing was. */
  async #answer(request: MarkdownWorkerRequest): Promise<void> {
    try {
      const made = await this.#make(request);
      this.#send({ status: "made", requestId: request.requestId, ...made }, [
        ...made.text,
        ...(made.html ?? []),
      ]);
    } catch (error: unknown) {
      this.#send(
        { status: "failed", requestId: request.requestId, reason: describeFailure(error) },
        [],
      );
    }
  }

  /** What `request` asks for: its HTML, or a drawn part's text, with its HTML as markdown. */
  async #make(request: MarkdownWorkerRequest): Promise<MarkdownWorkerMade> {
    if (request.kind === "html") {
      return { text: encodeTextPieces([markdownToHtml(decodeTextPieces(request.markdown))]) };
    }
    if (request.flavor === "text") {
      return { text: encodeTextPieces([drawnTreeText(request.tree, "text")]) };
    }
    const made = await drawnTreeMarkdown(request.tree, {
      alignments: request.tableAlignments,
      pull: (tableKey, firstIndex, lastIndex) =>
        new Promise((resolve) => {
          this.#asks.set(request.requestId, (rows) => {
            resolve(rows.map((row) => JSON.parse(row) as TableRow));
          });
          this.#send(
            { status: "pull", requestId: request.requestId, tableKey, firstIndex, lastIndex },
            [],
          );
        }),
    });
    return { text: encodeTextPieces(made.markdown), html: encodeTextPieces(made.html) };
  }
}
