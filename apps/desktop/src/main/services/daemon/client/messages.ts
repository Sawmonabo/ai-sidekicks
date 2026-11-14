// The messages the client helper exchanges with main over its parentPort: main's own requests and
// their answers, which are a window's too (`#shared/daemon/port-message.ts`), the link's connect
// and state, the service's ending and its process identity, which only main asks for, a window's
// port, and the file-path asks main answers for a window's call.

import type { DaemonEndingOutcome, DaemonEndingRequest } from "@ai-sidekicks/client-sdk";
import type { DaemonRepairingDetails } from "@ai-sidekicks/contracts/daemon/recovery";
import type { DaemonCannotStart } from "@ai-sidekicks/contracts/daemon/service-status";
import type { Issue } from "@ai-sidekicks/contracts/jsonrpc/issue";
import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { ConnectionInitializeResponse } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";

import type { FilePathRef } from "#shared/preload-api.js";
import type { ClientHelperAnswer, ClientHelperRequest } from "#shared/daemon/port-message.js";

/**
 * The link's state as the daemon client reports it while it holds the connection: `reconnecting`
 * after the socket dropped, `silent` after a daemon that stopped answering.
 */
export type ClientHelperLinkState = "open" | "quiet" | "reconnecting" | "silent" | "down";

/** The daemon client's fixed bounds and the status file's place, reported once at start. */
export interface ClientHelperFacts {
  readonly kind: "helper.started";
  /** How long a connect waits for a daemon that is starting, in milliseconds. */
  readonly handshakeDeadlineMs: number;
  /** How long a flush may take before a quit goes ahead without it, in milliseconds. */
  readonly flushWaitMs: number;
  /** The service's status file in this machine's run folder, or why this system has none. */
  readonly statusFile: { readonly path: string } | { readonly error: string };
}

/** Main's asks that end the service or read a process's identity, each answered by its `askId`. */
export type ClientHelperServiceAsk =
  | {
      /** End the service through the client's one ending. */
      readonly kind: "daemon.end";
      readonly askId: number;
      readonly request: DaemonEndingRequest;
      /** Whether the ending's handshake presents the token file's token. */
      readonly presentsToken: boolean;
    }
  | {
      /** End the service process `identity` names at once, as one that stopped answering. */
      readonly kind: "daemon.endProcess";
      readonly askId: number;
      readonly identity: ProcessIdentity;
    }
  | { readonly kind: "process.identityRead"; readonly askId: number; readonly processId: number };

/** The helper's answer to one of main's service asks. */
export type ClientHelperServiceAnswer =
  | { readonly kind: "daemon.ended"; readonly askId: number; readonly outcome: DaemonEndingOutcome }
  /** Answering the ask threw, with the failure's words. */
  | { readonly kind: "service.askFailed"; readonly askId: number; readonly error: string }
  | {
      readonly kind: "process.identity";
      readonly askId: number;
      /** The identity, or `undefined` when no process holds the id. */
      readonly identity: ProcessIdentity | undefined;
    }
  | { readonly kind: "process.identityRefused"; readonly askId: number; readonly error: string };

/**
 * What main sends the helper: its own requests, the one connect, the service asks, a window's port
 * (carried in the message's `ports`), and its answers to the helper's file-path asks.
 */
export type MainToClientHelperMessage =
  | ClientHelperRequest
  | ClientHelperServiceAsk
  | {
      /** Connect, or connect again once the last connect failed or the link was closed. */
      readonly kind: "link.connect";
      /** Whether the handshake presents the token file's token. */
      readonly presentsToken: boolean;
      /** Whether to wait for a daemon that is starting rather than try once. */
      readonly waitsForStart: boolean;
    }
  /**
   * Close the link: every call and stream on it ends, a connect under way is dropped, and the next
   * request waits for a connect.
   */
  | { readonly kind: "link.close" }
  | { readonly kind: "window.port"; readonly windowId: number }
  | {
      readonly kind: "filePaths.swapped";
      readonly askId: number;
      /** The params with each file token put back as its path. */
      readonly params: unknown;
      /** Whether the method's reply offers paths main mints tokens for. */
      readonly readsReply: boolean;
    }
  | { readonly kind: "filePaths.swapRefused"; readonly askId: number; readonly issues: Issue[] }
  | {
      readonly kind: "filePaths.minted";
      readonly askId: number;
      readonly fileRefs: Readonly<Record<string, FilePathRef>>;
    };

/**
 * What the helper sends main: its facts once at start, answers to main's own requests and service
 * asks, the link's connect and state, the file-path asks for a window's call, a window port it
 * stopped serving, and a flow update of its own the daemon did not take.
 */
export type ClientHelperToMainMessage =
  | ClientHelperFacts
  | ClientHelperAnswer
  | ClientHelperServiceAnswer
  | { readonly kind: "link.connected"; readonly initializeResponse: ConnectionInitializeResponse }
  | {
      readonly kind: "link.connectFailed";
      readonly error: JsonRpcError;
      /** Why the service cannot start, when the connect's failure says. */
      readonly cannotStart?: DaemonCannotStart;
    }
  | { readonly kind: "link.state"; readonly state: ClientHelperLinkState }
  /** A starting daemon answered that it is repairing its database file. */
  | { readonly kind: "link.repairing"; readonly details: DaemonRepairingDetails }
  | {
      readonly kind: "filePaths.swap";
      readonly askId: number;
      readonly windowId: number;
      readonly method: string;
      readonly params: unknown;
    }
  | {
      readonly kind: "filePaths.mint";
      /** The id of the swap a call's params went through, or a stream frame's own. */
      readonly askId: number;
      readonly windowId: number;
      readonly method: string;
      /** The params the daemon was sent, each token swapped for its path. */
      readonly params: unknown;
      /** The served reply or the stream frame, parsed. */
      readonly value: unknown;
    }
  | { readonly kind: "window.portDropped"; readonly windowId: number; readonly reason: string }
  | { readonly kind: "flowControl.failed"; readonly message: string };
