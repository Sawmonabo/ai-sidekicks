// The daemon's wire as the preload carries it to main. A call answers with main's outcome, a
// refusal rejecting with the wire error itself as a plain object: an Error would lose the error's
// code and data crossing to the page. A subscription is named here, opened synchronously so its
// open can throw, and fed by one listener for every value main pushes and one for every end.

import type { DaemonMethod, DaemonResult } from "@ai-sidekicks/contracts/daemon/methods";

import {
  BRIDGE_CHANNELS,
  DAEMON_SUBSCRIPTION_END_CHANNEL,
  DAEMON_SUBSCRIPTION_VALUE_CHANNEL,
  OPEN_DAEMON_SUBSCRIPTION_CHANNEL,
} from "#shared/bridge-channels.js";
import type {
  DaemonCallOutcome,
  DaemonCallRequest,
  DaemonSubscriptionEnd,
  DaemonSubscriptionOpening,
  DaemonSubscriptionRequest,
} from "#shared/daemon/forwarding.js";
import type { DaemonWire, ServedDaemonCall, Unsubscribe } from "#shared/preload-api.js";
import type { PreloadIpc } from "./ipc.js";

/**
 * The `daemon` member the preload exposes, carried over `ipc`, its subscriptions opened through
 * `subscriptions`.
 */
export function createDaemonWire(ipc: PreloadIpc, subscriptions: DaemonSubscriptions): DaemonWire {
  return {
    call: async <M extends DaemonMethod>(
      method: M,
      params: unknown,
    ): Promise<ServedDaemonCall<DaemonResult<M>>> =>
      settleDaemonCall(
        await ipc.invoke(BRIDGE_CHANNELS.daemonCall, {
          method,
          params,
        } satisfies DaemonCallRequest),
      ) as ServedDaemonCall<DaemonResult<M>>,
    requestStart: async (): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.requestDaemonStart);
    },
    subscribe: (event, params, handler, onEnded) =>
      subscriptions.open(event, params, handler as (value: unknown) => void, onEnded),
  };
}

/**
 * What a call main forwarded was served with: the value, and the file tokens main minted beside
 * it. Throws the daemon's refusal itself, and an `Error` carrying the message of any other failure.
 */
export function settleDaemonCall(answer: unknown): ServedDaemonCall<unknown> {
  const ended = answer as DaemonCallOutcome;
  if (ended.outcome === "served") {
    // The tokens cross IPC as strings; main minted each one as a `FilePathRef`.
    const fileRefs = ended.fileRefs as ServedDaemonCall<unknown>["fileRefs"];
    return fileRefs === undefined ? { value: ended.value } : { value: ended.value, fileRefs };
  }
  if (ended.outcome === "refused") {
    throw ended.refusal;
  }
  throw new Error(ended.message);
}

/** The page's open daemon subscriptions: each opened on main by an id named here. */
export class DaemonSubscriptions {
  readonly #ipc: PreloadIpc;
  readonly #byId = new Map<string, SubscriptionHandlers>();

  public constructor(ipc: PreloadIpc) {
    this.#ipc = ipc;
    ipc.on(DAEMON_SUBSCRIPTION_VALUE_CHANNEL, (_event, subscriptionId, value) => {
      // One closed while the value was in flight drops it.
      this.#byId.get(subscriptionId as string)?.deliver(value);
    });
    ipc.on(DAEMON_SUBSCRIPTION_END_CHANNEL, (_event, subscriptionId, end) => {
      const handlers = this.#byId.get(subscriptionId as string);
      if (handlers === undefined) {
        return;
      }
      this.#byId.delete(subscriptionId as string);
      handlers.onEnded?.(end as DaemonSubscriptionEnd);
    });
  }

  /**
   * Open one subscription on main and hand its values to `deliver` until it is closed or ends.
   * Throws when main could not open it. Closing it twice, or after it ended, sends nothing.
   */
  public open(
    event: string,
    params: unknown,
    deliver: (value: unknown) => void,
    onEnded: ((end: DaemonSubscriptionEnd) => void) | undefined,
  ): Unsubscribe {
    const subscriptionId = crypto.randomUUID();
    this.#byId.set(subscriptionId, { deliver, onEnded });
    // Synchronous because `subscribe` must return or throw before the caller goes on.
    const opening = this.#ipc.sendSync(OPEN_DAEMON_SUBSCRIPTION_CHANNEL, {
      subscriptionId,
      event,
      params,
    } satisfies DaemonSubscriptionRequest) as DaemonSubscriptionOpening;
    if (opening.outcome === "failed") {
      this.#byId.delete(subscriptionId);
      throw new Error(opening.message);
    }
    return () => {
      if (this.#byId.delete(subscriptionId)) {
        // The page has let go and waits on nothing, so a close main could not make is said in the
        // console rather than left as an unhandled rejection.
        this.#ipc
          .invoke(BRIDGE_CHANNELS.closeDaemonSubscription, subscriptionId)
          .catch((failure: unknown) => {
            console.error(`The daemon subscription ${subscriptionId} did not close:`, failure);
          });
      }
    };
  }
}

/** What one open subscription hands its values and its end to. */
interface SubscriptionHandlers {
  readonly deliver: (value: unknown) => void;
  readonly onEnded: ((end: DaemonSubscriptionEnd) => void) | undefined;
}
