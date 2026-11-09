// A session's shells, read off `terminal.subscribe`: the whole list in tab order when the stream
// opens and again on each change. Every delivery is checked here with the contract's generated
// check; one that does not match is dropped with its cause in the window's diagnostic capture, and
// the next change restates the whole list. A stream that ends is opened again and restates it; a
// re-open the daemon refuses is handed on until one works.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  validateTerminalListUpdate,
  type TerminalListEntry,
} from "@ai-sidekicks/contracts/terminal";

import { TERMINAL_LIST_STREAM } from "#shared/daemon/streams.js";
import { checkFaultPaths } from "#shared/daemon/fault-path.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { recordRefusedMemberPaths } from "#renderer/lib/diagnostic-capture/refused-member-record.js";
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
      if (validateTerminalListUpdate(payload)) {
        onFrame({ kind: "list", terminals: payload.terminals });
        return;
      }
      recordRefusedMemberPaths({
        source: "services/daemon",
        kind: "notice-unreadable",
        subject: TERMINAL_LIST_STREAM,
        issues: checkFaultPaths(validateTerminalListUpdate, payload),
      });
    },
    onReopenRefusal: (refusal) => {
      onFrame({ kind: "reopenRefusal", refusal });
    },
  });
}
