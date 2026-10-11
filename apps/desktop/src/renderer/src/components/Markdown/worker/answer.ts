// What the markdown worker makes for each request, on whichever thread runs it: the worker's own in
// the app, the test's where no worker runs.

import { decodeTextPieces, encodeTextPieces } from "#renderer/lib/text-pieces.js";
import { drawnTreeText } from "../drawn-text.js";
import { markdownToHtml } from "../html.js";
import type { MarkdownWorkerRequest } from "./messages.js";

/**
 * The text `request` asks for, as the UTF-8 bytes of its pieces. Throws as the reading it asks for
 * throws.
 */
export function answerMarkdownRequest(request: MarkdownWorkerRequest): ArrayBuffer[] {
  if (request.kind === "html") {
    return encodeTextPieces(markdownToHtml(decodeTextPieces(request.markdown)));
  }
  const blockSources = new Map(
    [...request.blockSources].map(([tableKey, message]) => [
      tableKey,
      { ...message, source: decodeTextPieces(message.source) },
    ]),
  );
  return encodeTextPieces(
    drawnTreeText(request.tree, request.flavor, (tableKey) => blockSources.get(tableKey)),
  );
}
