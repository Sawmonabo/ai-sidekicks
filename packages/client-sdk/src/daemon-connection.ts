// A connection to the daemon on this machine, opened the one way every client opens it: connect to
// its socket, check the run folder is this user's alone, read the session token the daemon wrote
// at its current start, then `daemon.hello` with that token before any other call. The token is read at every connect, never once, because
// each daemon start writes a new one, and read again once when the daemon refuses it. The
// acknowledged handshake comes back with the client, so the caller sees whether the daemon accepted
// this build's protocol.

import { lstat, readFile } from "node:fs/promises";
import * as os from "node:os";

import {
  assertPrivateRunFolder,
  resolveDaemonRunFolder,
  type DaemonRunFolder,
} from "@ai-sidekicks/contracts/daemon/run-folder";
import {
  CURRENT_PROTOCOL_VERSION,
  DAEMON_HELLO_METHOD,
  DaemonHelloAckSchema,
  DaemonHelloSchema,
  type DaemonHello,
  type DaemonHelloAck,
  NEGOTIATION_TOKEN_INVALID_CODE,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@ai-sidekicks/contracts/jsonrpc/negotiation";

import { JsonRpcClient, JsonRpcRemoteError } from "./transport/json-rpc.js";
import { connectLocalSocket } from "./transport/local-socket.js";
import type { ClientTransport } from "./transport/json-rpc.js";

/**
 * What a caller learns of an open connection's traffic: each frame the daemon sends, and the
 * connection's close. A supervisor reads the first to tell a quiet link from a dead one.
 */
export interface DaemonConnectionObserver {
  /** Called once for every frame that arrives from the daemon, a reply or a notification. */
  frameReceived(): void;
  /**
   * Called once when the connection closes: `reason` is the transport's error, or `undefined`
   * when this side closed it.
   */
  closed(reason: Error | undefined): void;
}

/** How to open a daemon connection. */
export interface DaemonConnectionOptions {
  /** The daemon's run folder; defaults to the one this user's daemon uses. */
  readonly runFolder?: DaemonRunFolder;
  /** The most unread values one subscription holds; see `JsonRpcClientOptions`. */
  readonly maxQueuedValuesPerSubscription: number;
  /**
   * Told of every frame, the handshake's own reply included, and of the close, which also comes
   * when the handshake fails and the connection it opened is closed.
   */
  readonly observer?: DaemonConnectionObserver;
}

/** An open daemon connection: the client, the daemon's handshake answer, and its close. */
export interface DaemonConnection {
  readonly client: JsonRpcClient;
  /**
   * The daemon's `daemon.hello` answer. When `compatible` is false the daemon refuses every
   * mutating call on this connection and read calls still work.
   */
  readonly hello: DaemonHelloAck;
  /** Closes the connection; every call still in flight rejects. */
  close(): Promise<void>;
}

/**
 * Connects to the daemon and completes `daemon.hello` with its session token. Throws
 * `JsonRpcTransportUnavailableError` when nothing answers on the socket; an `Error` when the run
 * folder is not this user's alone, or, with no `runFolder` given, on Windows, which has none; the
 * token file's read error, `code` `ENOENT` when a daemon has bound its socket and not yet written
 * its token; and `JsonRpcRemoteError` with `auth.token_invalid` when the daemon refuses the token
 * and the token file still holds the one presented. Any failure after a connect closes it.
 */
export async function connectToDaemon(options: DaemonConnectionOptions): Promise<DaemonConnection> {
  const runFolder = options.runFolder ?? defaultDaemonRunFolder();
  let presentedToken: string | undefined;
  const readPresentedToken = async (): Promise<string> => {
    presentedToken = await readFile(runFolder.tokenPath, "utf8");
    return presentedToken;
  };
  try {
    return await openDaemonConnection(runFolder, readPresentedToken, options);
  } catch (error) {
    // A daemon writes its token just after it binds, so a connect in between presents the previous
    // start's token. When the file has changed since, the refused connect is made once more with
    // the new token on a new connection, since the refused one serves nothing more.
    if (
      !(error instanceof JsonRpcRemoteError && error.data?.type === NEGOTIATION_TOKEN_INVALID_CODE)
    ) {
      throw error;
    }
    const currentToken = await readFile(runFolder.tokenPath, "utf8");
    if (currentToken === presentedToken) {
      throw error;
    }
    return openDaemonConnection(runFolder, () => Promise.resolve(currentToken), options);
  }
}

// Connects first, so a daemon that is not running reads as `transport.unavailable` rather than a
// missing run folder or token file, then checks the folder, reads the token and says hello.
async function openDaemonConnection(
  runFolder: DaemonRunFolder,
  readSessionToken: () => Promise<string>,
  options: DaemonConnectionOptions,
): Promise<DaemonConnection> {
  const socketTransport = await connectLocalSocket(runFolder.socketPath);
  const transport =
    options.observer === undefined
      ? socketTransport
      : observedTransport(socketTransport, options.observer);
  // The client takes the transport's close before anything can fail, so the observer hears the
  // close of a connection whose token could not be read. Each envelope carries this build's
  // protocol version, whose form the daemon checks.
  const client = new JsonRpcClient(transport, {
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    maxQueuedValuesPerSubscription: options.maxQueuedValuesPerSubscription,
  });
  try {
    // Before a byte is sent: a folder another account made could hold its own socket and token,
    // and the token would then prove nothing.
    assertPrivateRunFolder(
      runFolder.folderPath,
      await lstat(runFolder.folderPath),
      os.userInfo().uid,
    );
    const sessionToken = await readSessionToken();
    // The hello offers every version this build speaks and settles which one both sides use.
    const helloParams: DaemonHello = {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      supportedProtocols: SUPPORTED_PROTOCOL_VERSIONS,
      sessionToken,
    };
    const hello = await client.call(
      DAEMON_HELLO_METHOD,
      helloParams,
      DaemonHelloSchema,
      DaemonHelloAckSchema,
    );
    return { client, hello, close: () => transport.close() };
  } catch (error) {
    await transport.close();
    throw error;
  }
}

// The transport with each inbound frame and the close reported to the observer before the client
// handles it, so a frame that settles a call has already counted as traffic.
function observedTransport(
  transport: ClientTransport,
  observer: DaemonConnectionObserver,
): ClientTransport {
  return {
    send: (envelope) => transport.send(envelope),
    onMessage: (handler) => {
      transport.onMessage((message) => {
        observer.frameReceived();
        handler(message);
      });
    },
    onClose: (handler) => {
      transport.onClose((reason) => {
        observer.closed(reason);
        handler(reason);
      });
    },
    close: () => transport.close(),
  };
}

function defaultDaemonRunFolder(): DaemonRunFolder {
  return resolveDaemonRunFolder({
    platform: process.platform,
    runtimeDirectory: process.env["XDG_RUNTIME_DIR"],
    temporaryDirectory: os.tmpdir(),
    userId: os.userInfo().uid,
  });
}
