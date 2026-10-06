// One link to the background service, from the handshake to its loss. A busy link carries no
// check: after 5 seconds with no frame main asks the service to answer once, and after 20 seconds
// with none the link counts as dead. A closed socket ends it at once. Whatever happens, a link
// reports one connect, at most one error and exactly one loss, so nothing above counts a loss
// twice.

import {
  JsonRpcTransportPeerClosedError,
  type DaemonConnectionObserver,
} from "@ai-sidekicks/client-sdk";

/** How long a link may be quiet before main sends `daemon.ping`. */
export const LINK_QUIET_MS = 5_000;

/** How long a link may go with no frame at all before it counts as dead. */
export const LINK_DEAD_MS = 20_000;

/**
 * Why a link ended: the service went away (its socket closed), it went silent past the dead
 * line, main closed the link itself, or a cause main does not recognize.
 */
export type LinkLossCause =
  | { readonly kind: "serviceGone" }
  | { readonly kind: "silence" }
  | { readonly kind: "closedByMain" }
  | { readonly kind: "unrecognized" };

/** What a link tells its supervisor. Each is called at most once, `quiet` once per quiet spell. */
export interface LinkEvents {
  /** The handshake completed and the link is up. */
  connected(): void;
  /** The link has been quiet long enough to ask the service to answer. */
  quiet(): void;
  /** What went wrong, in the transport's own words, ahead of the loss it causes. */
  errored(message: string): void;
  /** The link is gone, and why. */
  lost(cause: LinkLossCause): void;
}

/** The phases a link passes through, once each and in order. */
type LinkPhase = "opening" | "up" | "lost";

/**
 * One link's watch: the observer handed to the connection, the quiet and dead timers, and the
 * one loss. Frames and a close that come before `open()` belong to a handshake that never
 * completed, which is a failed start rather than a link.
 */
export class LinkLifetime implements DaemonConnectionObserver {
  readonly #events: LinkEvents;
  readonly #closeConnection: () => void;
  #phase: LinkPhase = "opening";
  #silenceTimer: ReturnType<typeof setTimeout> | undefined;

  /** `closeConnection` drops the socket of a link that went silent. */
  public constructor(events: LinkEvents, closeConnection: () => void) {
    this.#events = events;
    this.#closeConnection = closeConnection;
  }

  /** The handshake completed: the link is up and its silence is now watched. */
  public open(): void {
    if (this.#phase !== "opening") {
      return;
    }
    this.#phase = "up";
    this.#events.connected();
    this.#watchSilence();
  }

  /** A frame arrived: the link is alive, so its silence is measured from now. */
  public frameReceived(): void {
    if (this.#phase === "up") {
      this.#watchSilence();
    }
  }

  /** The connection closed; the reason says whether the service went away or the link broke. */
  public closed(reason: Error | undefined): void {
    if (this.#phase !== "up") {
      return;
    }
    if (reason === undefined) {
      this.#lose({ kind: "closedByMain" }, undefined);
      return;
    }
    this.#lose(
      lossCauseOf(reason),
      reason instanceof JsonRpcTransportPeerClosedError ? undefined : reason.message,
    );
  }

  /** Main is letting the link go: no timer runs on and no loss is reported. */
  public end(): void {
    this.#phase = "lost";
    this.#stopWatching();
  }

  #watchSilence(): void {
    this.#stopWatching();
    this.#silenceTimer = setTimeout(() => {
      this.#events.quiet();
      this.#silenceTimer = setTimeout(() => {
        this.#lose(
          { kind: "silence" },
          `No frame from the background service for ${String(LINK_DEAD_MS / 1000)} seconds`,
        );
        this.#closeConnection();
      }, LINK_DEAD_MS - LINK_QUIET_MS);
    }, LINK_QUIET_MS);
  }

  #stopWatching(): void {
    if (this.#silenceTimer !== undefined) {
      clearTimeout(this.#silenceTimer);
      this.#silenceTimer = undefined;
    }
  }

  // The one place a link ends. Reached only while up, since `closed()` checks the phase and
  // leaving `up` clears the silence timer, so the error and the loss are each reported once.
  #lose(cause: LinkLossCause, errorMessage: string | undefined): void {
    this.#phase = "lost";
    this.#stopWatching();
    if (errorMessage !== undefined) {
      this.#events.errored(errorMessage);
    }
    this.#events.lost(cause);
  }
}

/** The socket errors that mean the service's end of the link is gone. */
const SERVICE_GONE_ERROR_CODES: readonly string[] = ["ECONNRESET", "EPIPE"];

function lossCauseOf(reason: Error): LinkLossCause {
  if (reason instanceof JsonRpcTransportPeerClosedError) {
    return { kind: "serviceGone" };
  }
  const code = "code" in reason ? reason.code : undefined;
  return typeof code === "string" && SERVICE_GONE_ERROR_CODES.includes(code)
    ? { kind: "serviceGone" }
    : { kind: "unrecognized" };
}
