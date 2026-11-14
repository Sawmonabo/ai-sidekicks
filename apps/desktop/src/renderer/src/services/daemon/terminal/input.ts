// One pane's typing into a shell, bound to the pane's open output subscription. The client helper's
// client keeps one queue for the shell that every pane's input shares, with every rule for its
// writes; the pane hears only its own writes refused, and a refusal cleared once one is taken.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import { REQUEST_UNSENDABLE_CODE, REQUEST_UNSENDABLE_MESSAGE } from "#shared/daemon/forwarding.js";
import type { ShellInput } from "#shared/preload-api.js";
import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import { normalizeWireRejection } from "#renderer/lib/wire/rejection.js";
import type { PlatformBridge } from "../../platform/bridge.js";
import { CALL_REJECTED_FALLBACK, DAEMON_REPLY_REFUSAL_ORIGIN } from "../reply.js";

/**
 * Open a pane's input to the shell its output subscription `outputSubscriptionId` follows.
 * `onRefusal` hears each of the pane's writes refused, and `undefined` once a write is taken.
 */
export function openShellInput(
  bridge: PlatformBridge,
  outputSubscriptionId: SubscriptionId,
  onRefusal: (refusal: Refusal | undefined) => void,
): ShellInput {
  return bridge.daemon.openShellInput(outputSubscriptionId, (answer) => {
    switch (answer.kind) {
      case "refused":
        onRefusal(
          normalizeWireRejection(
            DAEMON_REPLY_REFUSAL_ORIGIN,
            answer.refusal,
            CALL_REJECTED_FALLBACK,
          ),
        );
        return;
      case "unsent":
        onRefusal(
          refuse(DAEMON_REPLY_REFUSAL_ORIGIN, REQUEST_UNSENDABLE_CODE, REQUEST_UNSENDABLE_MESSAGE),
        );
        return;
      case "taken":
        onRefusal(undefined);
        return;
    }
  });
}
