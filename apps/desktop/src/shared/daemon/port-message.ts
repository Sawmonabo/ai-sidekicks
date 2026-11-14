// The messages a window and main exchange with the client helper: the requests each makes and the
// answers it gets, on the window's port or main's parentPort, and a window's typing into a shell
// with what it is told of the writes. Everything crosses by structured clone: a reply's JSON stays
// the text the daemon sent, parsed once by whoever reads it, and bytes cross as `Uint8Array`
// straight to the window that asked, never through main.

import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import type { FilePathRef, ShellWriteAnswer } from "../preload-api.js";
import type { DaemonSubscriptionEnd } from "./forwarding.js";

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
      /** Each path the value offers to open, and the token main minted for it. */
      readonly fileRefs?: Readonly<Record<string, FilePathRef>>;
    }
  | {
      readonly kind: "stream.ended";
      readonly streamId: number;
      readonly end: DaemonSubscriptionEnd;
    };

/**
 * What a window types or pastes into a shell, bound to the typing pane's open output subscription,
 * which the helper sends through the client's one queue for that shell.
 */
export type ClientHelperShellInput =
  | {
      readonly kind: "shell.keys";
      readonly outputSubscriptionId: SubscriptionId;
      readonly data: string;
    }
  | {
      readonly kind: "shell.paste";
      readonly outputSubscriptionId: SubscriptionId;
      readonly text: string;
    };

/** What a window sends the helper: a request main makes too, or a pane's input to a shell. */
export type ClientHelperWindowRequest = ClientHelperRequest | ClientHelperShellInput;

/** What the helper sends a window: an answer main gets too, or what a pane is told of its writes. */
export type ClientHelperWindowAnswer =
  | ClientHelperAnswer
  | {
      readonly kind: "shell.writeAnswered";
      /** The output subscription of the pane whose write it answers. */
      readonly outputSubscriptionId: SubscriptionId;
      readonly answer: ShellWriteAnswer;
    };
