// The websocket a Codex service is reached over, on the Unix socket the service listens on. The
// advertised socket path is a link to the real socket, and macOS refuses a socket path past 104
// bytes, so the client always dials the link's target.

import { type FSWatcher, watch } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

import { CODEX_MAX_RECEIVED_MESSAGE_BYTES } from "../server-requests.js";

// What a dial meets while a service it just started has not bound its socket yet: no socket, or a
// socket file a killed service left behind that nothing listens on.
const CODEX_SOCKET_NOT_LISTENING_CODES: ReadonlySet<string> = new Set(["ENOENT", "ECONNREFUSED"]);

// The upgrade answer's header in which the service names the largest message it takes in one
// frame; past it the service closes the socket.
const CODEX_MAX_UNFRAGMENTED_MESSAGE_BYTES_HEADER =
  "x-codex-websocket-max-unfragmented-message-bytes";

// An open websocket and the largest message the service said it takes.
interface CodexOpenWebSocket {
  readonly webSocket: WebSocket;
  readonly sentMessageByteLimit: number | undefined;
}

/** What a service socket reports to its owner. */
export interface CodexServiceSocketHandlers {
  /** One text message from the service. */
  onMessage(text: string): void;
  /** The socket closed, from either side; `detail` says why in words. Called once. */
  onClose(detail: string): void;
}

/** One open websocket to a Codex service. */
export interface CodexServiceSocket {
  /** Sends one text message; rejects when the socket did not take it. */
  send(text: string): Promise<void>;
  /** Closes the socket; `onClose` follows. Idempotent. */
  close(): void;
  /**
   * The largest message the service takes, in UTF-8 bytes, as it named it when the socket opened;
   * `undefined` when it named none.
   */
  readonly sentMessageByteLimit: number | undefined;
}

/** How to reach a service's socket: wait for it to listen (a service the daemon just started). */
export interface CodexServiceSocketDialOptions {
  /**
   * Waits for the service to listen rather than failing at once, for a service the daemon just
   * started; the person's own service is dialed as it is.
   */
  readonly awaitSocket: boolean;
  /** The service's `CODEX_HOME`, whose service this is. */
  readonly codexHome: string;
  /** Ends the wait and the upgrade; the dial rejects with the signal's reason. */
  readonly signal: AbortSignal;
}

/** Opens a websocket to the service listening on `socketPath`. */
export type CodexServiceSocketConnector = (
  socketPath: string,
  handlers: CodexServiceSocketHandlers,
  options: CodexServiceSocketDialOptions,
) => Promise<CodexServiceSocket>;

/**
 * Dials the service with `ws`, deflate off (a service offered it has answered with a dead
 * socket), with the bound on received messages on and the service's own limit on sent ones read
 * from its upgrade answer. Rejects when the signal aborts, when the link does not resolve
 * on a service it need not wait for, or when the upgrade fails for another reason than the service
 * not listening yet.
 */
export const connectCodexServiceSocket: CodexServiceSocketConnector = async (
  socketPath,
  handlers,
  options,
) => {
  const { webSocket, sentMessageByteLimit } = options.awaitSocket
    ? await dialWhenListening(socketPath, options.signal)
    : await openWebSocket(await realpath(socketPath), options.signal);
  let closed = false;
  const reportClose = (detail: string): void => {
    if (closed) {
      return;
    }
    closed = true;
    handlers.onClose(detail);
  };
  webSocket.on("message", (data) => {
    // A binary message is not JSON-RPC; decoded anyway, so it reaches the unparsable diagnostic.
    handlers.onMessage(decodeMessage(data));
  });
  webSocket.on("close", (code, reason) => {
    reportClose(`websocket closed with code ${code}${reason.length > 0 ? `: ${reason}` : ""}`);
  });
  return {
    send: (text) =>
      new Promise<void>((resolve, reject) => {
        webSocket.send(text, (error) => {
          if (error === undefined || error === null) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
    close: () => {
      webSocket.close();
    },
    sentMessageByteLimit,
  };
};

/** Opens the websocket on the real socket, ended at once when the signal aborts. */
async function openWebSocket(
  realSocketPath: string,
  signal: AbortSignal,
): Promise<CodexOpenWebSocket> {
  if (signal.aborted) {
    throw signal.reason;
  }
  const webSocket = new WebSocket(`ws+unix://${realSocketPath}:/`, {
    perMessageDeflate: false,
    maxPayload: CODEX_MAX_RECEIVED_MESSAGE_BYTES,
  });
  let sentMessageByteLimit: number | undefined;
  webSocket.once("upgrade", (response) => {
    const named = Number(response.headers[CODEX_MAX_UNFRAGMENTED_MESSAGE_BYTES_HEADER]);
    sentMessageByteLimit = Number.isSafeInteger(named) && named > 0 ? named : undefined;
  });
  // An error is reported through the open wait below and then through `close`, which follows
  // every error; without a standing listener one after the wait would throw.
  webSocket.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    const stopWaiting = (): void => {
      webSocket.off("open", onOpen);
      webSocket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onError = (error: Error): void => {
      stopWaiting();
      reject(error);
    };
    const onOpen = (): void => {
      stopWaiting();
      resolve();
    };
    const onAbort = (): void => {
      stopWaiting();
      webSocket.terminate();
      reject(signal.reason);
    };
    webSocket.once("open", onOpen);
    webSocket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return { webSocket, sentMessageByteLimit };
}

/**
 * Dials a service the daemon just started once it listens. The service makes its socket path a
 * link to a socket it binds elsewhere, so the link's folder and the real socket's folder are both
 * watched, and each change there tries again; no polling. A dial refused because nothing listens
 * yet, as on a socket a killed service left, waits for the next change.
 */
async function dialWhenListening(
  socketPath: string,
  signal: AbortSignal,
): Promise<CodexOpenWebSocket> {
  const linkFolder = path.dirname(socketPath);
  // Watched before the service makes it, so the folder is made here; the home is the app's.
  await mkdir(linkFolder, { recursive: true, mode: 0o700 });
  const changes = new CodexSocketFolderChanges(signal);
  try {
    changes.watchFolder(linkFolder);
    for (;;) {
      const changesSeen = changes.count;
      try {
        const realSocketPath = await realpath(socketPath);
        changes.watchFolder(path.dirname(realSocketPath));
        return await openWebSocket(realSocketPath, signal);
      } catch (error) {
        if (signal.aborted) {
          throw signal.reason;
        }
        if (!isSocketNotListening(error)) {
          throw error;
        }
      }
      await changes.waitForChangeAfter(changesSeen);
    }
  } finally {
    changes.close();
  }
}

/** Counts the changes in the watched folders, so a change during a dial is never missed. */
class CodexSocketFolderChanges {
  readonly #signal: AbortSignal;
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #waiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();
  #failure: unknown = undefined;
  count = 0;

  constructor(signal: AbortSignal) {
    this.#signal = signal;
  }

  /** Starts watching one folder, once. */
  watchFolder(folder: string): void {
    if (this.#watchers.has(folder)) {
      return;
    }
    const watcher = watch(folder);
    watcher.on("change", () => {
      this.count += 1;
      this.#settle((waiter) => {
        waiter.resolve();
      });
    });
    watcher.on("error", (error) => {
      this.#failure = error;
      this.#settle((waiter) => {
        waiter.reject(error);
      });
    });
    this.#watchers.set(folder, watcher);
  }

  /** Resolves once a change past the `changesSeen`th arrived; rejects on abort or watch error. */
  async waitForChangeAfter(changesSeen: number): Promise<void> {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    if (this.#signal.aborted) {
      throw this.#signal.reason;
    }
    if (this.count > changesSeen) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      const onAbort = (): void => {
        this.#waiters.delete(waiter);
        reject(this.#signal.reason);
      };
      this.#signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.add({
        resolve: () => {
          this.#signal.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (error) => {
          this.#signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
    });
  }

  /** Stops every watch. */
  close(): void {
    for (const watcher of this.#watchers.values()) {
      watcher.close();
    }
    this.#watchers.clear();
  }

  #settle(
    finish: (waiter: { resolve: () => void; reject: (error: unknown) => void }) => void,
  ): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) {
      finish(waiter);
    }
  }
}

function isSocketNotListening(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return typeof code === "string" && CODEX_SOCKET_NOT_LISTENING_CODES.has(code);
}

function decodeMessage(data: WebSocket.RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return (data instanceof ArrayBuffer ? Buffer.from(data) : data).toString("utf8");
}
