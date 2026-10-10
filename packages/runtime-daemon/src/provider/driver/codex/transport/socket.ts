// The websocket a Codex service is reached over, on the Unix socket the service listens on. Where
// Node opens a Unix socket, the socket is dialed directly: the advertised socket path is a link to
// the real socket, and macOS refuses a socket path past 104 bytes, so the link's target is dialed.
// Where Node opens none, the websocket runs over `codex app-server proxy`, which carries its
// standard input and output to the socket.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { type FSWatcher, watch } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { Duplex } from "node:stream";
import WebSocket from "ws";

import type { ProviderOperatingSystem } from "../../../operating-system/contract.js";
import type { ResolvedProviderExecutable } from "../../../spawned-version.js";
import { CODEX_MAX_RECEIVED_MESSAGE_BYTES } from "../server-requests.js";

// The most of a failed proxy's error output kept for the failure's message.
const CODEX_PROXY_OUTPUT_TAIL_MAX_LENGTH = 1_000;

// What a dial meets while a service it just started has not bound its socket yet: no socket, or a
// socket file a killed service left behind that nothing listens on.
const CODEX_SOCKET_NOT_LISTENING_CODES: ReadonlySet<string> = new Set(["ENOENT", "ECONNREFUSED"]);

// The upgrade answer's header in which the service names the largest message it takes in one
// frame; past it the service closes the socket.
const CODEX_MAX_UNFRAGMENTED_MESSAGE_BYTES_HEADER =
  "x-codex-websocket-max-unfragmented-message-bytes";

// An open websocket to a service, the largest message the service said it takes, and how the
// daemon closes it.
interface CodexOpenWebSocket {
  readonly webSocket: WebSocket;
  readonly sentMessageByteLimit: number | undefined;
  readonly close: () => void;
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
  /** The Codex build the daemon resolved for the service, whose proxy a dial may run. */
  readonly codexBuild: ResolvedProviderExecutable;
  /** Ends the wait and the upgrade; the dial rejects with the signal's reason. */
  readonly signal: AbortSignal;
}

/** Opens a websocket to the service listening on `socketPath`. */
export type CodexServiceSocketConnector = (
  socketPath: string,
  handlers: CodexServiceSocketHandlers,
  options: CodexServiceSocketDialOptions,
) => Promise<CodexServiceSocket>;

// One try at the socket, given the folder watch of a dial that waits for it; rejects with a
// not-listening failure while nothing listens there yet.
type CodexSocketAttempt = (
  changes: CodexSocketFolderChanges | undefined,
) => Promise<CodexOpenWebSocket>;

/**
 * The connector that dials the socket as the operating system can, and hands each message and the
 * close to the socket's owner. A dial rejects when the signal aborts, or when the socket cannot be
 * reached for another reason than a service the daemon just started not listening yet.
 */
export function createCodexServiceSocketConnector(
  operatingSystem: Pick<ProviderOperatingSystem, "canOpenUnixSocket" | "endChildProcess">,
): CodexServiceSocketConnector {
  return async (socketPath, handlers, options) => {
    const attempt: CodexSocketAttempt = operatingSystem.canOpenUnixSocket
      ? async (changes) => {
          const realSocketPath = await realpath(socketPath);
          changes?.watchFolder(path.dirname(realSocketPath));
          return await openCodexWebSocket(`ws+unix://${realSocketPath}:/`, options.signal);
        }
      : async () => await openThroughProxy(socketPath, options, operatingSystem.endChildProcess);
    const opened = options.awaitSocket
      ? await dialWhenListening(socketPath, options.signal, attempt)
      : await attempt(undefined);
    return exposeServiceSocket(opened, handlers);
  };
}

/**
 * Dials a service the daemon just started once it listens. The socket's folder is watched, and the
 * real socket's where the path is a link to it, and each change there tries again; no polling. A
 * dial refused because nothing listens yet, as on a socket a killed service left, waits for the
 * next change.
 */
async function dialWhenListening(
  socketPath: string,
  signal: AbortSignal,
  attempt: CodexSocketAttempt,
): Promise<CodexOpenWebSocket> {
  const socketFolder = path.dirname(socketPath);
  // Watched before the service makes it, so the folder is made here; the home is the app's.
  await mkdir(socketFolder, { recursive: true, mode: 0o700 });
  const changes = new CodexSocketFolderChanges(signal);
  try {
    changes.watchFolder(socketFolder);
    for (;;) {
      const changesSeen = changes.count;
      try {
        return await attempt(changes);
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

// A proxy that ended with a failure before the websocket opened, as for a socket nothing listens
// on yet.
class CodexProxyEndedError extends Error {}

// Opens the websocket over the build's own `app-server proxy`; the proxy ends with the websocket.
async function openThroughProxy(
  socketPath: string,
  options: CodexServiceSocketDialOptions,
  endChildProcess: ProviderOperatingSystem["endChildProcess"],
): Promise<CodexOpenWebSocket> {
  const { start, environment } = options.codexBuild;
  const proxy = spawn(
    start.program,
    [...start.leadingArguments, "app-server", "proxy", "--sock", socketPath],
    { env: Object.fromEntries(environment), stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  let outputTail = "";
  const keepTail = (text: string): void => {
    outputTail = (outputTail + text).slice(-CODEX_PROXY_OUTPUT_TAIL_MAX_LENGTH);
  };
  proxy.stderr.setEncoding("utf8");
  proxy.stderr.on("data", keepTail);
  const closed = new Promise<number | null>((resolve) => {
    proxy.once("close", resolve);
  });
  // The start's own failure rejects the wait below; a later one is told in the failure's text.
  await once(proxy, "spawn");
  proxy.on("error", (error) => {
    keepTail(`\n${error.message}`);
  });
  try {
    const opened = await openCodexWebSocket("ws://localhost/", options.signal, () =>
      Duplex.from({ readable: proxy.stdout, writable: proxy.stdin }),
    );
    opened.webSocket.once("close", () => {
      if (proxy.exitCode === null) {
        endChildProcess(proxy, "stop");
      }
    });
    // The proxy passes on no closing handshake, so a close waits out `ws`'s closing deadline;
    // the daemon's close ends the stream at once instead, which ends the proxy.
    return {
      ...opened,
      close: () => {
        opened.webSocket.terminate();
      },
    };
  } catch (error) {
    endChildProcess(proxy, "kill");
    const exitCode = await closed;
    if (exitCode !== null && exitCode !== 0) {
      throw new CodexProxyEndedError(
        `The Codex proxy to ${socketPath} ended with code ${String(exitCode)}: ${outputTail}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function exposeServiceSocket(
  { webSocket, sentMessageByteLimit, close }: CodexOpenWebSocket,
  handlers: CodexServiceSocketHandlers,
): CodexServiceSocket {
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
    close,
    sentMessageByteLimit,
  };
}

// Opens the websocket at `address` with `ws`, deflate off (a service offered it has answered with
// a dead socket), with the bound on received messages on and the service's own limit on sent ones
// read from its upgrade answer; over `createConnection`'s stream where one is given. Ended at once
// when the signal aborts.
async function openCodexWebSocket(
  address: string,
  signal: AbortSignal,
  createConnection?: () => Duplex,
): Promise<CodexOpenWebSocket> {
  if (signal.aborted) {
    throw signal.reason;
  }
  const webSocket = new WebSocket(address, {
    perMessageDeflate: false,
    maxPayload: CODEX_MAX_RECEIVED_MESSAGE_BYTES,
    ...(createConnection === undefined ? {} : { createConnection }),
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
  return {
    webSocket,
    sentMessageByteLimit,
    close: () => {
      webSocket.close();
    },
  };
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
  if (error instanceof CodexProxyEndedError) {
    return true;
  }
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return typeof code === "string" && CODEX_SOCKET_NOT_LISTENING_CODES.has(code);
}

function decodeMessage(data: WebSocket.RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return (data instanceof ArrayBuffer ? Buffer.from(data) : data).toString("utf8");
}
