// The preload's daemon members. A new channel to the client helper is made here: one end goes to
// main, which hands it to the helper, and the other to the page as a window message, so the page's
// calls and streams ride it with no copy through the context bridge. Main's own topics, the
// daemon's status and the machine settings' feed, are subscribed here over IPC, each named here,
// opened synchronously so its open can throw, and fed by one listener for every value main pushes
// and one for every end. A call main answers with an outcome rejects, for a refusal, with the wire
// error itself as a plain object: an Error would lose the error's code and data crossing to the
// page.

import {
  BRIDGE_CHANNELS,
  DAEMON_PORT_MESSAGE,
  DAEMON_SUBSCRIPTION_END_CHANNEL,
  DAEMON_SUBSCRIPTION_VALUE_CHANNEL,
  OPEN_DAEMON_PORT_CHANNEL,
  OPEN_DAEMON_SUBSCRIPTION_CHANNEL,
} from "#shared/bridge-channels.js";
import {
  REQUEST_UNSENDABLE_CODE,
  REQUEST_UNSENDABLE_MESSAGE,
  type DaemonCallOutcome,
  type DaemonSubscriptionEnd,
  type DaemonSubscriptionOpening,
  type DaemonSubscriptionRequest,
} from "#shared/daemon/forwarding.js";
import { DAEMON_STATUS_TOPIC } from "#shared/daemon/status-topic.js";
import type { DaemonPreload, ServedDaemonCall, Unsubscribe } from "#shared/preload-api.js";
import type { PreloadIpc } from "./ipc.js";

/** Where the page's end of a new channel goes: the page's own window. */
export interface PagePortTarget {
  postMessage(message: unknown, targetOrigin: string, transfer: unknown[]): void;
}

/**
 * The `daemon` member the preload exposes, carried over `ipc`, main's status topic opened through
 * `subscriptions`, each new channel's page end posted to `page`.
 */
export function createDaemonPreload(
  ipc: Pick<PreloadIpc, "invoke" | "postMessage">,
  subscriptions: DaemonSubscriptions,
  page: PagePortTarget,
): DaemonPreload {
  return {
    openPort: () => {
      const channel = new MessageChannel();
      ipc.postMessage(OPEN_DAEMON_PORT_CHANNEL, null, [channel.port1]);
      // Posted to the page's own window, which alone can receive it.
      page.postMessage(DAEMON_PORT_MESSAGE, "*", [channel.port2]);
    },
    subscribeStatus: (handler) =>
      subscriptions.open(DAEMON_STATUS_TOPIC, {}, handler as (value: unknown) => void, undefined),
    requestStart: async (): Promise<void> => {
      await ipc.invoke(BRIDGE_CHANNELS.requestDaemonStart);
    },
  };
}

/**
 * What a call main answered was served with: the value, and the file tokens main minted beside it.
 * Throws the refusal itself, the app's `request-unsendable` refusal for a request main did not
 * send, and an `Error` carrying the message of any other failure.
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
  if (ended.outcome === "unsendable") {
    throw requestUnsendable();
  }
  throw new Error(ended.message);
}

/** The page's open subscriptions to main's topics: each opened on main by an id named here. */
export class DaemonSubscriptions {
  readonly #ipc: Pick<PreloadIpc, "invoke" | "sendSync">;
  readonly #byId = new Map<string, SubscriptionHandlers>();

  public constructor(ipc: Pick<PreloadIpc, "invoke" | "sendSync" | "on">) {
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
   * Open one topic on main and hand its values to `deliver` until it is closed or ends. Throws
   * when main could not open it. Closing it twice, or after it ended, sends nothing.
   */
  public open(
    event: string,
    params: unknown,
    deliver: (value: unknown) => void,
    onEnded: ((end: DaemonSubscriptionEnd) => void) | undefined,
  ): Unsubscribe {
    const subscriptionId = crypto.randomUUID();
    this.#byId.set(subscriptionId, { deliver, onEnded });
    // Synchronous because a subscribe must return or throw before the caller goes on.
    const opening = this.#ipc.sendSync(OPEN_DAEMON_SUBSCRIPTION_CHANNEL, {
      subscriptionId,
      event,
      params,
    } satisfies DaemonSubscriptionRequest) as DaemonSubscriptionOpening;
    if (opening.outcome === "unsendable") {
      this.#byId.delete(subscriptionId);
      throw requestUnsendable();
    }
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
            console.error(`The subscription ${subscriptionId} did not close:`, failure);
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

// The app's own refusal for a request main did not send: an `Error` keeps its message across to
// the page, and the code beside it is what the page reads it by.
function requestUnsendable(): Error {
  return Object.assign(new Error(REQUEST_UNSENDABLE_MESSAGE), { code: REQUEST_UNSENDABLE_CODE });
}
