// What the markdown worker makes for each request, on whichever thread runs it: the worker's own in
// the app, the test's where no worker runs. Requests are answered as they come, once the parser is
// loaded, a drawn part's waiting on the page for each answer to its asks for undrawn rows while the
// next request starts.

import type { Root, TableRow } from "mdast";

import { decodeTextPieces, encodeTextPieces } from "#renderer/lib/text-pieces.js";
import { describeFailure } from "#shared/failure-message.js";
import { drawnTreeMarkdown, drawnTreeText } from "../drawn-text.js";
import { markdownTreeToHtml } from "../html.js";
import type {
  MarkdownWorkerMade,
  MarkdownWorkerReply,
  MarkdownWorkerRequest,
  UndrawnRowsAnswer,
} from "./messages.js";

/** Parses a markdown text into the tree the screen draws, on the thread that calls it. */
export type MarkdownTreeParser = (source: string) => Root;

/** The worker's side of its talk with the page about what it makes, sending each reply by `send`. */
export class MarkdownWorkerAnswers {
  readonly #send: (reply: MarkdownWorkerReply, transfer: readonly Transferable[]) => void;
  readonly #parser: Promise<MarkdownTreeParser | undefined>;
  /** Takes the page's answer to each request's unanswered ask for rows, by the request's id. */
  readonly #asks = new Map<number, (rows: readonly string[]) => void>();

  /**
   * `send` posts a reply to the page, moving the buffers in `transfer`; `parser` resolves once the
   * parser is loaded, or to `undefined` when it failed to load, after which nothing is answered.
   */
  public constructor(
    send: (reply: MarkdownWorkerReply, transfer: readonly Transferable[]) => void,
    parser: Promise<MarkdownTreeParser | undefined>,
  ) {
    this.#send = send;
    this.#parser = parser;
  }

  /**
   * Starts answering a request, or hands rows to the ask waiting on them. Throws for rows no ask
   * waits on, which only a page out of step with the worker sends.
   */
  public hear(message: MarkdownWorkerRequest | UndrawnRowsAnswer): void {
    if (message.kind !== "undrawn-rows") {
      void this.#parser.then((parseMarkdown) =>
        parseMarkdown === undefined ? undefined : this.#answer(message, parseMarkdown),
      );
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
  async #answer(request: MarkdownWorkerRequest, parseMarkdown: MarkdownTreeParser): Promise<void> {
    try {
      const made = await this.#make(request, parseMarkdown);
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
  async #make(
    request: MarkdownWorkerRequest,
    parseMarkdown: MarkdownTreeParser,
  ): Promise<MarkdownWorkerMade> {
    if (request.kind === "html") {
      const html = markdownTreeToHtml(parseMarkdown(decodeTextPieces(request.markdown)));
      return { text: encodeTextPieces([html]) };
    }
    if (request.flavor === "text") {
      return { text: encodeTextPieces([drawnTreeText(request.tree, "text")]) };
    }
    const made = await drawnTreeMarkdown(
      request.tree,
      {
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
      },
      parseMarkdown,
    );
    return { text: encodeTextPieces(made.markdown), html: encodeTextPieces(made.html) };
  }
}
