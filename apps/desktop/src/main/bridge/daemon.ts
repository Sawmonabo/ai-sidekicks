// Main's part in the page's daemon wire, which otherwise runs between the page and the client
// helper over the window's port. The helper asks main to put each file token a window's call
// carries back as its path, and to mint a token for each path the reply offers to open
// (`file-path/relay.ts`); main answers for the window that made the call, and removes the pasted
// pictures the service copied.
//
// Main's own topics reach the page over IPC, where the page subscribes and closes by an id it
// names: `daemon.status` delivers the link's state, the current one first, while no service
// answers too, and ends only when the page closes it or goes. Another topic main serves, as the
// machine settings' feed, opens through the opener its module hands in, and an end it reaches
// while the page still holds it is told to the page.

import {
  DAEMON_SUBSCRIPTION_END_CHANNEL,
  DAEMON_SUBSCRIPTION_VALUE_CHANNEL,
} from "#shared/bridge-channels.js";
import type {
  DaemonRequestUnsendable,
  DaemonSubscriptionEnd,
  DaemonSubscriptionOpening,
} from "#shared/daemon/forwarding.js";
import { DAEMON_STATUS_TOPIC } from "#shared/daemon/status-topic.js";
import type { FilePathAnswer, FilePathAsk } from "../services/daemon/client/process.js";
import type { DaemonLink } from "../services/daemon/link/status.js";
import type { MainDiagnosticLog } from "../services/diagnostic-log.js";
import { isPlainObject } from "../services/plain-object.js";
import {
  copiedFilePaths,
  mintTokensForPaths,
  readsReplyPaths,
  swapTokensForPaths,
} from "./file-path/relay.js";
import type { FilePathRefOwner, FilePathRefs } from "./file-path/refs.js";
import type { PastedImages } from "./native/file-intake.js";

/** What main answers the helper's file-path asks from. */
export interface FilePathAskServices {
  readonly filePathRefs: FilePathRefs;
  readonly pastedImages: Pick<PastedImages, "removeCopied">;
}

/**
 * Main's answer to one file-path ask for `window`'s call. A swap puts each token back as its path;
 * a mint removes the pasted pictures the service copied and mints a token for each path the reply
 * offers. Throws a `TypeError` for a value in a path member that is not a token `window` holds.
 */
export function answerFilePathAsk(
  services: FilePathAskServices,
  window: FilePathRefOwner,
  ask: FilePathAsk,
): FilePathAnswer {
  if (ask.kind === "filePaths.swap") {
    return {
      kind: "filePaths.swapped",
      askId: ask.askId,
      params: swapTokensForPaths(services.filePathRefs, window, ask.method, ask.params),
      readsReply: readsReplyPaths(ask.method),
    };
  }
  services.pastedImages.removeCopied(window, copiedFilePaths(ask.method, ask.params, ask.value));
  return {
    kind: "filePaths.minted",
    askId: ask.askId,
    fileRefs: mintTokensForPaths(services.filePathRefs, window, ask.method, ask.value),
  };
}

/**
 * The page a topic delivers to: its id, the pushes its values and its end ride on, and the two
 * moments its subscriptions end, when it is destroyed and when it navigates to a new document.
 */
export interface DaemonSubscriber {
  readonly id: number;
  send(channel: string, subscriptionId: string, delivery: unknown): void;
  once(event: "destroyed", listener: () => void): unknown;
  on(event: "did-navigate", listener: () => void): unknown;
}

/** How a topic answered its open: opened, with how main closes it, or why not. */
export type MainTopicOpening =
  | { readonly outcome: "opened"; readonly close: () => void }
  | Exclude<DaemonSubscriptionOpening, { readonly outcome: "opened" }>;

/**
 * Opens one topic main serves with the params the page sent, delivering its values and its end;
 * an end is told at most once and after it nothing is delivered.
 */
export type MainTopicOpener = (
  params: unknown,
  deliver: (value: unknown) => void,
  onEnded: (end: DaemonSubscriptionEnd) => void,
) => MainTopicOpening;

/** What the page's topics are served over: the link, the other topics, and the log. */
export interface MainTopicsOptions {
  readonly link: Pick<DaemonLink, "subscribe">;
  /** The topics besides `daemon.status`, by the name the page opens them with. */
  readonly topics: Readonly<Record<string, MainTopicOpener>>;
  readonly log: Pick<MainDiagnosticLog, "write">;
}

/** One topic a page holds open: how main ends it, set once it has opened. */
interface OpenTopic {
  close: () => void;
}

/** The topics main serves the pages over IPC, and each page's open subscriptions to them. */
export class MainTopics {
  readonly #openers: ReadonlyMap<string, MainTopicOpener>;
  readonly #log: Pick<MainDiagnosticLog, "write">;
  /** Each page's open subscriptions, by the id its preload named them with. */
  readonly #subscriptionsByPage = new Map<number, Map<string, OpenTopic>>();

  public constructor(options: MainTopicsOptions) {
    this.#log = options.log;
    this.#openers = new Map([
      ...Object.entries(options.topics),
      [DAEMON_STATUS_TOPIC, statusTopicOver(options.link)],
    ]);
  }

  /**
   * Open one topic for a page and push its values to it until it is closed, ends, or the page
   * goes. Answers synchronously: opened, or why not. A request that is not a new id, a topic main
   * serves and its params is refused before anything opens.
   */
  public open(page: DaemonSubscriber, request: unknown): DaemonSubscriptionOpening {
    if (
      !isPlainObject(request) ||
      typeof request["subscriptionId"] !== "string" ||
      typeof request["event"] !== "string"
    ) {
      return this.#unsendable("A topic is opened with a new id, a topic name and its request.");
    }
    const subscriptionId = request["subscriptionId"];
    const event = request["event"];
    const opener = this.#openers.get(event);
    if (opener === undefined) {
      return this.#unsendable(`Main serves no topic ${event}.`);
    }
    const subscriptions = this.#subscriptionsOf(page);
    if (subscriptions.has(subscriptionId)) {
      return this.#unsendable("That subscription is already open.");
    }
    const entry: OpenTopic = { close: () => undefined };
    const isHeld = (): boolean => subscriptions.get(subscriptionId) === entry;
    subscriptions.set(subscriptionId, entry);
    const opening = opener(
      request["params"],
      (value) => {
        if (isHeld()) {
          page.send(DAEMON_SUBSCRIPTION_VALUE_CHANNEL, subscriptionId, value);
        }
      },
      (end) => {
        if (isHeld()) {
          subscriptions.delete(subscriptionId);
          page.send(DAEMON_SUBSCRIPTION_END_CHANNEL, subscriptionId, end);
        }
      },
    );
    if (opening.outcome !== "opened") {
      subscriptions.delete(subscriptionId);
      if (opening.outcome === "unsendable") {
        this.#log.write({
          level: "warning",
          source: LOG_SOURCE,
          message: `The ${event} request does not match its contract.`,
        });
      }
      return opening;
    }
    entry.close = opening.close;
    // An end told while it opened leaves nothing to close later.
    if (!isHeld()) {
      opening.close();
    }
    return { outcome: "opened" };
  }

  /** Close one of a page's subscriptions; one that already ended, or no id, does nothing. */
  public close(page: Pick<DaemonSubscriber, "id">, subscriptionId: unknown): void {
    if (typeof subscriptionId !== "string") {
      return;
    }
    const subscriptions = this.#subscriptionsByPage.get(page.id);
    const subscription = subscriptions?.get(subscriptionId);
    if (subscriptions === undefined || subscription === undefined) {
      return;
    }
    subscriptions.delete(subscriptionId);
    subscription.close();
  }

  // A request the app built off its contract: the log names what was asked, and the page is told
  // only that it could not be sent.
  #unsendable(detail: string): DaemonRequestUnsendable {
    this.#log.write({ level: "warning", source: LOG_SOURCE, message: detail });
    return { outcome: "unsendable" };
  }

  /** A page's subscriptions, ending them all when it is destroyed or loads a new document. */
  #subscriptionsOf(page: DaemonSubscriber): Map<string, OpenTopic> {
    const known = this.#subscriptionsByPage.get(page.id);
    if (known !== undefined) {
      return known;
    }
    const subscriptions = new Map<string, OpenTopic>();
    this.#subscriptionsByPage.set(page.id, subscriptions);
    page.on("did-navigate", () => {
      closeEvery(subscriptions);
    });
    page.once("destroyed", () => {
      closeEvery(subscriptions);
      this.#subscriptionsByPage.delete(page.id);
    });
    return subscriptions;
  }
}

const LOG_SOURCE = "main/bridge/daemon";

/** The `daemon.status` topic: the link's state, the current one first; it takes nothing. */
function statusTopicOver(link: Pick<DaemonLink, "subscribe">): MainTopicOpener {
  return (params, deliver) =>
    isPlainObject(params) && Object.keys(params).length === 0
      ? { outcome: "opened", close: link.subscribe(deliver) }
      : { outcome: "unsendable" };
}

function closeEvery(subscriptions: Map<string, OpenTopic>): void {
  const open = [...subscriptions.values()];
  // Cleared first, so an end that lands as these close sees the page no longer holds it.
  subscriptions.clear();
  for (const subscription of open) {
    subscription.close();
  }
}
