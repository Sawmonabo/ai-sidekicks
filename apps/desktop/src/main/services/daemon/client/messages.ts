// The messages the client helper exchanges with main over its parentPort and with each window over
// the port main hands it for that window. Everything crosses by structured clone: a reply's JSON
// stays the text the daemon sent, parsed once by whoever reads it, and bytes cross as `Uint8Array`
// straight to the window that asked, never through main.

import type { Issue } from "@ai-sidekicks/contracts/jsonrpc/issue";
import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";

import type { FilePathRef } from "#shared/preload-api.js";
import type { DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";

/**
 * What main or a window asks the helper: a call, a stream opened, or the cancel of either. Each id
 * is the asker's own, unique among its open calls or streams.
 */
export type ClientHelperRequest =
  | {
      readonly kind: "call";
      readonly callId: number;
      readonly method: string;
      readonly params: unknown;
      /** The bytes each `{"$bytes": n}` placeholder in `params` names, in placeholder order. */
      readonly attachments: readonly Uint8Array[];
    }
  | { readonly kind: "call.cancel"; readonly callId: number }
  | {
      readonly kind: "stream.open";
      readonly streamId: number;
      readonly method: string;
      readonly params: unknown;
      readonly attachments: readonly Uint8Array[];
    }
  | { readonly kind: "stream.close"; readonly streamId: number };

/**
 * What the helper answers on the channel a request came from. A call ends once, served, refused in
 * the wire's error shape or failed on the helper's side by its message. A stream that opened sends
 * the daemon's acknowledgment first, then each value, and its end once, unless the asker closed it.
 */
export type ClientHelperAnswer =
  | {
      readonly kind: "call.served";
      readonly callId: number;
      /** The reply's JSON text as the daemon sent it. */
      readonly json: string;
      readonly attachments: readonly Uint8Array[];
      /** Each path the reply offers to open, and the token main minted for it. */
      readonly fileRefs?: Readonly<Record<string, FilePathRef>>;
    }
  | { readonly kind: "call.refused"; readonly callId: number; readonly refusal: JsonRpcError }
  | { readonly kind: "call.failed"; readonly callId: number; readonly message: string }
  | {
      readonly kind: "stream.opened";
      readonly streamId: number;
      /** The daemon's acknowledgment of the subscribe, as JSON text. */
      readonly json: string;
      readonly attachments: readonly Uint8Array[];
    }
  | {
      readonly kind: "stream.value";
      readonly streamId: number;
      readonly json: string;
      readonly attachments: readonly Uint8Array[];
    }
  | {
      readonly kind: "stream.ended";
      readonly streamId: number;
      readonly end: DaemonSubscriptionEnd;
    };

/** The link's state as the daemon client reports it while it holds the connection. */
export type ClientHelperLinkState = "open" | "quiet" | "reconnecting" | "down";

/**
 * What main sends the helper: its own requests, the one connect, a window's port (carried in the
 * message's `ports`), and its answers to the helper's file-path asks.
 */
export type MainToClientHelperMessage =
  | ClientHelperRequest
  | {
      readonly kind: "link.connect";
      /** Whether the app runs packaged: the packaged Mac app presents no token. */
      readonly isPackaged: boolean;
      readonly platform: NodeJS.Platform;
    }
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
      /** The served reply, parsed. */
      readonly value: unknown;
    }
  | { readonly kind: "window.portDropped"; readonly windowId: number; readonly reason: string };
