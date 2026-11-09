// How a call or subscription the app carries to the daemon ends, as the page, main and the client
// helper pass it to each other: a message port keeps no error, so a call ends with an outcome
// rather than a throw, and a subscription that ends is told as an end rather than left to go
// quiet.

import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";

/**
 * The app's own code for a call or subscription main did not send, because the app built it off
 * its contract; the method's name goes to main's log, never to the page.
 */
export const REQUEST_UNSENDABLE_CODE = "request-unsendable";

/** What the page reads for a {@link REQUEST_UNSENDABLE_CODE} refusal. */
export const REQUEST_UNSENDABLE_MESSAGE =
  "This request could not be sent to the background service.";

/**
 * A daemon subscription the renderer asks main to open. The preload names it, so values pushed
 * later find their handler and a later close names the same subscription.
 */
export interface DaemonSubscriptionRequest {
  readonly subscriptionId: string;
  readonly event: string;
  readonly params: unknown;
}

/**
 * How a forwarded call ended: the daemon's result, with a token main minted for each path it
 * offers to open, keyed by the path, where it offers one; the daemon's refusal, carrying only the
 * wire error's code, message and data; or a failure on main's side of the wire, by its message
 * alone.
 */
export type DaemonCallOutcome =
  | {
      readonly outcome: "served";
      readonly value: unknown;
      /** Each path the value offers to open, and the `FilePathRef` token main minted for it. */
      readonly fileRefs?: Readonly<Record<string, string>>;
    }
  | { readonly outcome: "refused"; readonly refusal: JsonRpcError }
  | DaemonRequestUnsendable
  | { readonly outcome: "failed"; readonly message: string };

/** Whether main opened a subscription, or why it could not. */
export type DaemonSubscriptionOpening =
  | { readonly outcome: "opened" }
  | DaemonRequestUnsendable
  | { readonly outcome: "failed"; readonly message: string };

/** A call or subscription main did not send, because the app built it off its contract. */
export interface DaemonRequestUnsendable {
  readonly outcome: "unsendable";
}

/**
 * How a subscription that opened ended without the page closing it: the daemon completed it, the
 * daemon refused it, carrying only the wire error's code, message and data, or the link under it
 * failed, by its message alone. Main sends it once, and nothing follows it on that subscription.
 */
export type DaemonSubscriptionEnd =
  | { readonly reason: "completed" }
  | { readonly reason: "refused"; readonly refusal: JsonRpcError }
  | { readonly reason: "failed"; readonly message: string };

/** One line saying how a subscription ended, for a diagnostic record. */
export function describeSubscriptionEnd(end: DaemonSubscriptionEnd): string {
  switch (end.reason) {
    case "completed":
      return "completed";
    case "refused":
      return `refused: ${end.refusal.message}`;
    case "failed":
      return `failed: ${end.message}`;
  }
}
