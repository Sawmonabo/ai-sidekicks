// A session's shells, read off `terminal.subscribe`: the whole list in tab order when the stream
// opens and again on each change. A stream that ends is opened again and restates it; a re-open
// the daemon refuses is handed on until one works.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TerminalListEntry, TerminalListUpdate } from "@ai-sidekicks/contracts/terminal";

import { TERMINAL_LIST_STREAM } from "#shared/daemon/streams.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import type { PlatformBridge } from "../../platform/bridge.js";
import { openReopeningSubscription } from "../../transport/reopening-subscription.js";

/**
 * One delivery on a session's shell list: the shells as they now stand, or why the stream cannot
 * be opened again (`undefined` once a re-open works).
 */
export type ShellListFrame =
  | { readonly kind: "list"; readonly terminals: readonly TerminalListEntry[] }
  | { readonly kind: "reopenRefusal"; readonly refusal: Refusal | undefined };

/** Follow one session's shells over `bridge`, handing each frame on until the handle releases it. */
export function followShellList(
  bridge: PlatformBridge,
  sessionId: SessionId,
  onFrame: (frame: ShellListFrame) => void,
): Unsubscribe {
  return openReopeningSubscription({
    signal: bridge.transportReconnect,
    subject: TERMINAL_LIST_STREAM,
    firstOpenFailure: "refuseAndRetry",
    open: (deliver, onEnded) =>
      bridge.daemon.subscribe(TERMINAL_LIST_STREAM, { sessionId }, deliver, onEnded),
    onFrame: (payload) => {
      onFrame({ kind: "list", terminals: (payload as TerminalListUpdate).terminals });
    },
    onReopenRefusal: (refusal) => {
      onFrame({ kind: "reopenRefusal", refusal });
    },
  });
}
