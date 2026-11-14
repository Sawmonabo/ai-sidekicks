// One pane's typing into a shell, bound to the pane's open output subscription. The client helper's
// client keeps one queue for the shell that every pane's input shares, with every rule for its
// writes; the pane hears only its own writes refused, a refusal cleared once one is taken, the
// input handed back unsent once the subscription ends or the input closes, for the pane to send on
// its next one, and, once a closed input has handed back all it held, that it is closed.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import type { ShellInput, UnsentShellInput } from "#shared/preload-api.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { normalizeWireRejection } from "#renderer/lib/wire/rejection.js";
import type { PlatformBridge } from "../../platform/bridge.js";
import { CALL_REJECTED_FALLBACK, DAEMON_REPLY_REFUSAL_ORIGIN } from "../reply.js";

/** What a pane hears of its input's writes. */
export interface ShellInputListener {
  /** Each of the pane's writes refused, and `undefined` once a write is taken. */
  readonly onRefusal: (refusal: Refusal | undefined) => void;
  /** Input handed back unsent: its subscription ended, or the input closed. */
  readonly onUnsent: (input: UnsentShellInput) => void;
  /** The closed input hands back nothing more. */
  readonly onClosed: () => void;
}

/** Open a pane's input to the shell its output subscription `outputSubscriptionId` follows. */
export function openShellInput(
  bridge: PlatformBridge,
  outputSubscriptionId: SubscriptionId,
  listener: ShellInputListener,
): ShellInput {
  return bridge.daemon.openShellInput(outputSubscriptionId, (answer) => {
    switch (answer.kind) {
      case "refused":
        listener.onRefusal(
          normalizeWireRejection(
            DAEMON_REPLY_REFUSAL_ORIGIN,
            answer.refusal,
            CALL_REJECTED_FALLBACK,
          ),
        );
        return;
      case "unsent":
        listener.onUnsent(answer.input);
        return;
      case "taken":
        listener.onRefusal(undefined);
        return;
      case "closed":
        listener.onClosed();
        return;
    }
  });
}
