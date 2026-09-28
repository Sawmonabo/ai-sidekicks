// The harness the attention binding's test drives it through: the settle, and the two
// calls a composition supplies it.
//
// THE FAKED CONTEXT IS THE SIBLING MODULE, `session-surface.context.test-support.ts`.

import { act } from "@testing-library/react";

import {
  PAST_REFRESH_DEBOUNCE_MS,
  settle as settleReactWork,
} from "../core/settle.test-support.js";
import type { AttentionItem } from "../bridge/index.js";
import type { SessionDirectoryReadCall } from "../seats/index.js";
import type { AttentionProjectionReadCall } from "./notifications/index.js";

/**
 * Let the binding's asynchronous arrivals land.
 *
 * Two reads settle behind the binding — the attention projection and the node's
 * session directory — and each settles an effect that can schedule the next, so the
 * count is the depth of that chain rather than a number picked to make a test pass.
 *
 * The attention read is the one that also costs TIME. It goes through the console's
 * one refresh scheduler, so its first read lands a debounce interval after the
 * subscribe rather than on the next microtask, and that interval runs on the wall
 * clock.
 */
export async function settle(): Promise<void> {
  await settleReactWork();
  await act(async () => {
    await new Promise((resolveAfterDebounce) => {
      setTimeout(resolveAfterDebounce, PAST_REFRESH_DEBOUNCE_MS);
    });
  });
}

/**
 * The two calls the window's composition supplies the binding, answering as a case says.
 *
 * Built once per mount, because a call's identity is the subject its reading is held
 * under: a fresh call per render would restart the read on every pass.
 */
export function callsAnswering(answers: {
  /** The sessions the node lists. A served, empty directory unless a case names some. */
  readonly directorySessionIds?: readonly string[];
  /** The attention items the projection serves, whichever session raised them. */
  readonly attentionItems?: readonly AttentionItem[];
}): {
  readonly readDirectory: SessionDirectoryReadCall;
  readonly readAttention: AttentionProjectionReadCall;
} {
  const directorySessionIds = answers.directorySessionIds ?? [];
  return {
    readDirectory: () =>
      Promise.resolve(directorySessionIds.map((sessionId) => ({ sessionId, state: "active" }))),
    readAttention: () =>
      Promise.resolve({
        items: answers.attentionItems ?? [],
        droppedCount: 0,
        refusedSessions: [],
        addressedSessionIds: directorySessionIds,
      }),
  };
}
