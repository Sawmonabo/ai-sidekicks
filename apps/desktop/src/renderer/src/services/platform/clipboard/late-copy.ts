// A copy whose content comes after it was asked for, as a long selection's text read in slices
// or a picture's encoding does, or whose text is ready but too long for one message. Main reads
// what the clipboard holds when the copy is asked for, and the content is written only while the
// clipboard still holds that, so a copy made meanwhile, in this app or another, stands. The
// content's text and formatted flavor go to main a few pieces a slice before the write that names
// them, so no message, and no task on the page, grows with the text; main holds one copy's pieces
// at a time, and a copy that settles lets its pieces go. Until a system-clipboard copy has written
// or given up it is held in the bridge's pending copies, which a paste in this app waits for.

import { piecedTextOf, TEXT_PIECE_LENGTH, type PiecedText } from "#renderer/lib/text-pieces.js";
import { workInSlices } from "#renderer/lib/work-slices.js";
import type { ClipboardContent, ClipboardPiece } from "#shared/preload-api.js";
import type { PlatformBridge } from "../bridge.js";

/** A copy's text and any formatted flavor, each held in pieces. */
export interface PiecedTextClipboardContent {
  readonly text: PiecedText;
  readonly html?: PiecedText;
}

/** What a late copy writes: its text and any formatted flavor in pieces, or a picture. */
export type PiecedClipboardContent =
  | PiecedTextClipboardContent
  | Extract<ClipboardContent, { readonly png: unknown }>;

/** Writes a late copy's content in one write: whether it was written. */
export type LateClipboardWrite = (content: PiecedClipboardContent) => Promise<boolean>;

/**
 * Adds `html` beside the text a late copy wrote, in one write, while the system clipboard still
 * holds that text: whether it was added.
 */
export type LateClipboardFormatting = (html: PiecedText) => Promise<boolean>;

/** Content ready when its copy is asked for: text and any formatted flavor, whole or in pieces. */
export type ReadyClipboardContent = ClipboardContent | PiecedClipboardContent;

/**
 * Starts a copy now whose content `build` writes later through the write it is handed, which
 * lands only while no newer copy took the clipboard, and whose formatted flavor it may add after
 * its text through the second function; settles as `build` does, once the copy's pieces main
 * holds are let go. Pieces are sent a few a slice in `view`. A copy to the system clipboard is
 * pending until its first write settles or `build` settles, whichever comes first. A refused read
 * of the clipboard rejects that write.
 */
export async function copyOnceBuilt<Result>(
  bridge: PlatformBridge,
  view: Window,
  build: (write: LateClipboardWrite, addFormatting: LateClipboardFormatting) => Promise<Result>,
  clipboard?: "selection",
): Promise<Result> {
  const snapshot = bridge.native.takeClipboardSnapshot(clipboard);
  // A refused read rejects the write that awaits it; a copy that writes nothing waits on none.
  snapshot.catch(() => undefined);
  let endPending = (): void => undefined;
  if (clipboard === undefined) {
    bridge.pendingClipboardCopies.hold(
      new Promise((resolve) => {
        endPending = resolve;
      }),
    );
  }
  const copyId = crypto.randomUUID();
  let isSent = false;
  const send = async (flavor: ClipboardPiece["flavor"], text: PiecedText): Promise<void> => {
    isSent = true;
    await sendPieces(bridge, view, { copyId, flavor }, text.pieces);
  };
  const write: LateClipboardWrite = async (content) => {
    try {
      if ("png" in content) {
        return await bridge.native.copyToClipboardUnlessChanged(content, await snapshot);
      }
      await send("text", content.text);
      if (content.html !== undefined) {
        await send("html", content.html);
      }
      return await bridge.native.copyToClipboardUnlessChanged({ copyId }, await snapshot);
    } finally {
      endPending();
    }
  };
  const addFormatting: LateClipboardFormatting = async (html) => {
    await send("html", html);
    return await bridge.native.addClipboardFormatting(copyId);
  };
  try {
    return await build(write, addFormatting);
  } finally {
    endPending();
    // A newer copy's first piece has let these go already, which this asks again harmlessly.
    if (isSent) {
      await bridge.native.dropClipboardPieces(copyId);
    }
  }
}

/**
 * Puts content ready now on the system clipboard: a picture, or text whose flavors together fit
 * one piece, as one message; longer text sent in pieces a few a slice in `view` and written as a
 * late copy's is, so no message, and no task on the page, grows with the text, and a paste in this
 * app waits for it. Resolves whether it was written: `false` once a newer copy took the clipboard
 * while the pieces were sent. Rejects when main refuses a piece or the write.
 */
export async function copyReadyContent(
  bridge: PlatformBridge,
  view: Window,
  content: ReadyClipboardContent,
): Promise<boolean> {
  if ("png" in content) {
    await bridge.native.copyToClipboard(content);
    return true;
  }
  const text = wholeTextOf(content.text);
  const html = content.html === undefined ? undefined : wholeTextOf(content.html);
  if (text.length + (html?.length ?? 0) <= TEXT_PIECE_LENGTH) {
    await bridge.native.copyToClipboard(html === undefined ? { text } : { text, html });
    return true;
  }
  const pieced: PiecedTextClipboardContent =
    content.html === undefined
      ? { text: piecedOf(content.text) }
      : { text: piecedOf(content.text), html: piecedOf(content.html) };
  return await copyOnceBuilt(bridge, view, (write) => write(pieced));
}

function wholeTextOf(text: string | PiecedText): string {
  return typeof text === "string" ? text : text.text;
}

function piecedOf(text: string | PiecedText): PiecedText {
  return typeof text === "string" ? piecedTextOf(text) : text;
}

/**
 * Sends main `pieces` of the copy and flavor `piece` names, in order, as many a slice in `view`
 * as it has time for; an empty text goes as one empty piece, since its first piece starts a copy.
 * Rejects once any piece's send has, after every send settles.
 */
async function sendPieces(
  bridge: PlatformBridge,
  view: Window,
  piece: Pick<ClipboardPiece, "copyId" | "flavor">,
  pieces: readonly string[],
): Promise<void> {
  const toSend = pieces.length === 0 ? [""] : pieces;
  const sent: Promise<void>[] = [];
  await workInSlices(
    view,
    (hasTime) => {
      for (const text of toSend.slice(sent.length)) {
        const sending = bridge.native.sendClipboardPiece({
          ...piece,
          index: sent.length,
          piece: text,
        });
        // Marked as handled while later slices run; `Promise.all` below rejects with it.
        sending.catch(() => undefined);
        sent.push(sending);
        if (!hasTime()) {
          break;
        }
      }
      return sent.length === toSend.length;
    },
    () => false,
  );
  await Promise.all(sent);
}
