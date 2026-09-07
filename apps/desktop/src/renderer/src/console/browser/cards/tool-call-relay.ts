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
//
// AND THE ACCUMULATION SURVIVES THE PRODUCER, WHICHEVER WAY THE PRODUCER GOES. A
// relayed call is a HISTORICAL invocation — it happened, and it goes on having
// happened after the subscription that reported it closes — so a terminal arm that
// dropped the list would erase every call the session made at the moment the stream
// stopped, and the feed would render its own sentence over nothing at all. The ending
// is a fact about the SUBSCRIPTION and never about the calls, so all three settled
// arms carry the same bounded list the served arm was carrying.
//
// WHICH IS WHY THE REFUSED ARM CARRIES ONE TOO, and why its SCOPE is read off that
// list rather than fixed. `primitives/partial-read.ts` closes the refusal scope at
// two, and the difference between them is exactly this question: a refusal that IS
// the whole answer, and a refusal that arrived BESIDE one. An iterator that throws
// having relayed nothing is the first; one that throws after relaying six
// invocations is the second, and reporting it as the first tells a person the window
// knows nothing about what the agent did while six cards it had already drawn
// disappear underneath the sentence saying so.

import { useEffect } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { normalizeWireRejection, RELAYED_TOOL_CALL_ROW_CAP } from "../../core/index.js";
import type { ReadingState, RefusalScope } from "../../primitives/index.js";
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

/**
 * What the pane knows about the agent's browser tool calls right now.
 *
 * EVERY SETTLED ARM CARRIES THE LIST, and they carry the same one. `served` is a live
 * subscription, `ended` is one whose producer finished, and `refused` is one that
 * broke; what differs is whether another call can still arrive and whether anything
 * is wrong, not which calls have already been made. Only `reading` carries none,
 * because at that point none has.
 */
export type ToolCallReading =
  | Extract<ReadingState, { readonly kind: "reading" }>
  | (Extract<ReadingState, { readonly kind: "served" }> & {
      readonly calls: readonly RelayedToolCall[];
    })
  | (Extract<ReadingState, { readonly kind: "refused" }> & {
      readonly calls: readonly RelayedToolCall[];
    })
  | { readonly kind: "ended"; readonly calls: readonly RelayedToolCall[] };

const UNREAD_TOOL_CALLS: ToolCallReading = { kind: "reading" };

/**
 * What a refusal is the answer to, decided by whether anything else answered.
 *
 * Read off the accumulated list rather than fixed at the call site, which is the one
 * place this decision can be right: `whole-answer` claims there is nothing else on
 * screen, and after even one relayed call that is false. Decided here, once, so the
 * two refusal publications below cannot disagree about it and no render body
 * re-derives it.
 */
function refusalScopeFor(seen: readonly RelayedToolCall[]): RefusalScope {
  return seen.length === 0 ? "whole-answer" : "beside-an-answer";
}

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
          // Nothing has been relayed yet on this path by construction — the
          // subscription was never opened — so the scope reads `whole-answer` from
          // the same accessor the catch below uses rather than being asserted here.
          publish({ kind: "refused", scope: refusalScopeFor(seen), refusal: outcome, calls: seen });
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
          // The list the loop above accumulated, handed on verbatim: the producer
          // ending says nothing about the calls it already relayed.
          publish({ kind: "ended", calls: seen });
        }
      } catch (failure) {
        closeStream();
        if (!cancelled) {
          // The list the loop had accumulated when the iterator threw, handed on for
          // the reason the ended arm hands its own on: those invocations were made,
          // and a producer breaking afterwards says nothing about them.
          publish({
            kind: "refused",
            scope: refusalScopeFor(seen),
            refusal: normalizeWireRejection(
              TOOL_RELAY_REFUSAL_ORIGIN,
              failure,
              RELAY_FAILURE_FALLBACK,
            ),
            calls: seen,
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
