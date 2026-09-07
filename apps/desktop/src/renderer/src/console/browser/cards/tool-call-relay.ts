// The daemon-to-desktop relay of agent browser tool calls, as a reading.
//
// `Spec-023 §Console Design (Meridian)` 12.7: every page-tool invocation "renders as
// an ordinary tool row in the timeline, and every page it opens renders in the pane".
// The pane's own reading of that relay is what puts the call in front of the person
// watching the page it is about to act on — the timeline row is the record, and this
// is the thing happening now.
//
// SAME FOUR ARMS AND SAME FOUR ENDINGS as the pane's other two subscriptions, for the
// same reasons `navigation-state.ts` states at length. What differs is what a frame
// MEANS: navigation and the page list each carry the whole current state, so a frame
// replaces the reading. A tool call is an EVENT — one invocation, once — so frames
// accumulate, and this reading holds the calls it has seen rather than the last one.
//
// AND THE ACCUMULATION IS BOUNDED. A session an agent browses in for an hour is a
// session with thousands of tool calls, and a shelf inside a disclosure is not where
// an hour of them belongs. The reading keeps the newest and drops the rest, which is
// a display bound rather than one of the resource ceilings 12.10 enumerates — no tool
// result is truncated, no call is refused, and nothing about what the daemon did
// changes. What is dropped is a row nobody scrolled to.

import { useEffect } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { normalizeWireRejection, RELAYED_TOOL_CALL_ROW_CAP } from "../../core/index.js";
import type { ReadingState } from "../../primitives/index.js";
import { useSubjectScopedState } from "../../store/index.js";

/** The subsystem name every refusal this module raises itself carries. */
const TOOL_RELAY_REFUSAL_ORIGIN = "browser-tool-relay";

/** What a broken tool relay refuses under, where the failure carries no code. */
const RELAY_FAILURE_FALLBACK = {
  code: "tool-relay-failed",
  detail:
    "Browser tool calls are no longer being relayed to this window. Closing the pane and opening it again starts a new subscription.",
};

/** The subscription's own outcome type, and the shape read out of it. */
type ToolCallOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["browserSubscribeToolCalls"]>>;
type ToolCallStream = Extract<ToolCallOutcome, { readonly status: "served" }>["value"];

/** One relayed call, as every surface in this family reads it. */
export type RelayedToolCall = ToolCallStream extends {
  readonly events: AsyncIterable<infer Event>;
}
  ? Event
  : never;

/** What the pane knows about the agent's browser tool calls right now. */
export type ToolCallReading =
  | Extract<ReadingState, { readonly kind: "reading" }>
  | (Extract<ReadingState, { readonly kind: "served" }> & {
      readonly calls: readonly RelayedToolCall[];
    })
  | Extract<ReadingState, { readonly kind: "refused" }>
  | { readonly kind: "ended" };

const UNREAD_TOOL_CALLS: ToolCallReading = { kind: "reading" };

/**
 * Subscribe to the tool calls the daemon relays for this session.
 *
 * Keyed by SESSION and not by pane, because that is what the operation takes: the
 * relay is the session's, and a pane is one window onto it. A pane with no session
 * behind it puts no subscription at all and reads the unread arm — which is true, and
 * is not the same as a session that relays nothing.
 */
export function useRelayedToolCalls(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
): ToolCallReading {
  const { value: reading, publish } = useSubjectScopedState(
    bridge,
    sessionId ?? "",
    () => UNREAD_TOOL_CALLS,
  );

  useEffect(() => {
    if (sessionId === undefined) {
      return;
    }
    let stream: ToolCallStream | undefined;
    let cancelled = false;
    let seen: readonly RelayedToolCall[] = [];
    const closeStream = (): void => {
      const acquired = stream;
      stream = undefined;
      acquired?.close();
    };
    void (async () => {
      try {
        const outcome = await bridge.growth.browserSubscribeToolCalls({ sessionId });
        if (cancelled) {
          if (outcome.status === "served") {
            outcome.value.close();
          }
          return;
        }
        if (outcome.status === "unavailable") {
          publish({ kind: "refused", scope: "whole-answer", refusal: outcome });
          return;
        }
        stream = outcome.value;
        for await (const call of stream.events) {
          if (cancelled) {
            return;
          }
          // Newest first, and the tail is dropped rather than kept: the list is what
          // the shelf renders, so an unbounded one would be a growing allocation
          // nobody looks at for the life of the window.
          seen = [call, ...seen].slice(0, RELAYED_TOOL_CALL_ROW_CAP);
          publish({ kind: "served", calls: seen });
        }
        closeStream();
        if (!cancelled) {
          publish({ kind: "ended" });
        }
      } catch (failure) {
        closeStream();
        if (!cancelled) {
          publish({
            kind: "refused",
            scope: "whole-answer",
            refusal: normalizeWireRejection(
              TOOL_RELAY_REFUSAL_ORIGIN,
              failure,
              RELAY_FAILURE_FALLBACK,
            ),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      closeStream();
    };
  }, [bridge, publish, sessionId]);

  return reading;
}
