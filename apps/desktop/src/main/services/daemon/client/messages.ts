// The messages the client helper exchanges with main over its parentPort: main's own requests and
// their answers, which are a window's too (`#shared/daemon/port-message.ts`), the link's connect
// and state, a window's port, and the file-path asks main answers for a window's call.

import type { Issue } from "@ai-sidekicks/contracts/jsonrpc/issue";
import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";

import type { FilePathRef } from "#shared/preload-api.js";
import type { ClientHelperAnswer, ClientHelperRequest } from "#shared/daemon/port-message.js";

/** The link's state as the daemon client reports it while it holds the connection. */
export type ClientHelperLinkState = "open" | "quiet" | "reconnecting" | "down";

/**
 * What main sends the helper: its own requests, the one connect, a window's port (carried in the
 * message's `ports`), and its answers to the helper's file-path asks.
 */
export type MainToClientHelperMessage =
  | ClientHelperRequest
  | {
      /** Connect, or connect again once the last connect failed or the link was closed. */
      readonly kind: "link.connect";
      /** Whether the app runs packaged: the packaged Mac app presents no token. */
      readonly isPackaged: boolean;
      readonly platform: NodeJS.Platform;
    }
  /** Close the link: every call and stream on it ends, and the next request waits for a connect. */
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
 * What the helper sends main: answers to main's own requests, the link's connect and state, the
 * file-path asks for a window's call, and a window port it stopped serving.
 */
export type ClientHelperToMainMessage =
  | ClientHelperAnswer
  | { readonly kind: "link.connected" }
  | { readonly kind: "link.connectFailed"; readonly error: JsonRpcError }
  | { readonly kind: "link.state"; readonly state: ClientHelperLinkState }
  | {
      readonly kind: "filePaths.swap";
      readonly askId: number;
      readonly windowId: number;
      readonly method: string;
      readonly params: unknown;
    }
  | {
      readonly kind: "filePaths.mint";
      /** The id of the swap the call's params went through. */
      readonly askId: number;
      readonly windowId: number;
      readonly method: string;
      /** The params the daemon was sent, each token swapped for its path. */
      readonly params: unknown;
      /** The served reply, parsed. */
      readonly value: unknown;
    }
  | { readonly kind: "window.portDropped"; readonly windowId: number; readonly reason: string };
