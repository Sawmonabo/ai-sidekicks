// One shell's output, read off `terminal.output.subscribe`: the scrollback window when the stream
// opens, then what the shell writes, each frame checked here with the contract's generated check
// and its bytes put back in place. The newest output offset is kept, so a stream that ends is
// opened again after it and the daemon sends only the bytes past it, or a fresh scrollback when
// the offset has left its window. A frame that does not match is recorded and the stream opened
// again with no offset, so the window is drawn afresh rather than with a hole in it. Each open
// hands on the subscription's id, which a write or a take on the shell is bound to, and each end
// says the id is gone, so nothing is bound to it while the stream is opened again.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  validateTerminalOutputFrame,
  type TerminalId,
  type TerminalOutputFrame,
} from "@ai-sidekicks/contracts/terminal";

import { TERMINAL_OUTPUT_STREAM } from "#shared/daemon/streams.js";
import { checkFaultPaths } from "#shared/daemon/fault-path.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { recordRefusedMemberPaths } from "#renderer/lib/diagnostic-capture/refused-member-record.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import type { PlatformBridge } from "../../platform/bridge.js";
import { openReopeningSubscription } from "../../transport/reopening-subscription.js";
import { withBytesPlaced } from "../wire/attachments.js";

/** The shell an output stream follows. */
export interface ShellOutputSubject {
  readonly sessionId: SessionId;
  readonly terminalId: TerminalId;
}

/**
 * One delivery on a shell's output stream: a subscription opened with its id, the subscription
 * ended, a checked frame with its bytes in place, or why the stream cannot be opened again
 * (`undefined` once a re-open works).
 */
export type ShellOutputDelivery =
  | { readonly kind: "opened"; readonly subscriptionId: SubscriptionId }
  | { readonly kind: "ended" }
  | { readonly kind: "frame"; readonly frame: TerminalOutputFrame }
  | { readonly kind: "reopenRefusal"; readonly refusal: Refusal | undefined };

/** Follow one shell's output over `bridge`, handing each delivery on until the handle releases it. */
export function followShellOutput(
  bridge: PlatformBridge,
  subject: ShellOutputSubject,
  onDelivery: (delivery: ShellOutputDelivery) => void,
): Unsubscribe {
  const follower = new ShellOutputFollower(bridge, subject, onDelivery);
  follower.open();
  return () => {
    follower.release();
  };
}

/** A frame as the port delivers it: the checked-later value and the bytes beside it. */
interface DeliveredFrame {
  readonly payload: unknown;
  readonly attachments: readonly Uint8Array[];
}

/** One shell's output stream and the offset it has drawn to, from its first open to its release. */
class ShellOutputFollower {
  readonly #bridge: PlatformBridge;
  readonly #subject: ShellOutputSubject;
  readonly #onDelivery: (delivery: ShellOutputDelivery) => void;
  #afterOffset: number | undefined;
  #release: Unsubscribe | undefined;

  public constructor(
    bridge: PlatformBridge,
    subject: ShellOutputSubject,
    onDelivery: (delivery: ShellOutputDelivery) => void,
  ) {
    this.#bridge = bridge;
    this.#subject = subject;
    this.#onDelivery = onDelivery;
  }

  public open(): void {
    this.#release = openReopeningSubscription<DeliveredFrame>({
      signal: this.#bridge.transportReconnect,
      subject: TERMINAL_OUTPUT_STREAM,
      firstOpenFailure: "refuseAndRetry",
      open: (deliver, onEnded) =>
        this.#bridge.daemon.subscribe(
          TERMINAL_OUTPUT_STREAM,
          {
            ...this.#subject,
            ...(this.#afterOffset === undefined ? {} : { afterOffset: this.#afterOffset }),
          },
          (payload, attachments) => {
            deliver({ payload, attachments });
          },
          (end) => {
            this.#onDelivery({ kind: "ended" });
            onEnded(end);
          },
          (subscriptionId) => {
            this.#onDelivery({ kind: "opened", subscriptionId });
          },
        ),
      onFrame: (delivered) => {
        this.#receive(delivered);
      },
      onReopenRefusal: (refusal) => {
        this.#onDelivery({ kind: "reopenRefusal", refusal });
      },
    });
  }

  public release(): void {
    this.#release?.();
    this.#release = undefined;
  }

  #receive({ payload, attachments }: DeliveredFrame): void {
    if (!validateTerminalOutputFrame.call({ attachments }, payload)) {
      recordRefusedMemberPaths({
        source: "services/daemon",
        kind: "notice-unreadable",
        subject: TERMINAL_OUTPUT_STREAM,
        issues: checkFaultPaths(validateTerminalOutputFrame, payload),
      });
      // Opened again from no offset: the daemon answers with a fresh scrollback window.
      this.release();
      this.#onDelivery({ kind: "ended" });
      this.#afterOffset = undefined;
      this.open();
      return;
    }
    const frame = withBytesPlaced(payload, attachments) as TerminalOutputFrame;
    this.#afterOffset = frame.changes[frame.changes.length - 1]?.cursor;
    this.#onDelivery({ kind: "frame", frame });
  }
}
