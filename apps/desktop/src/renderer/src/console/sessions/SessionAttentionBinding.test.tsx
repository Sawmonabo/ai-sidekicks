// The count outlives the destination — the whole reason the binding seat exists.
//
// `rail-attention.test.ts` next door already asserts what a reading is WORTH: which
// arms suppress the count and why zero is an absence. Nothing there is about LIFETIME,
// and lifetime is what was wrong: the read was mounted by the sessions destination, so
// a person who navigated to Workspace took the rail's badge down with them and the
// window said "nothing is waiting on you" while the daemon was answering perfectly
// well. That is the stale-versus-absent distinction `Spec-023 §The surface set` is
// built on, answered wrongly — and it is invisible to every case that mounts one tree and
// leaves it mounted.
//
// SO EVERY CASE HERE SWAPS THE SUBTREE. The child under the binding is what a route
// change replaces, so re-rendering with a different child is a navigation as far as
// this seam is concerned, and the assertion is taken from the frame store the rail
// reads — not from the DOM, because the rail is not in this tree and asserting on a
// badge would be asserting on the surface that draws it.
//
// AND THE PLANTED CONTROL IS THE OLD SHAPE. The last case mounts the publisher INSIDE
// the swapped child, which is where it used to live, and shows the count going to
// nothing on the same navigation the binding survives. Without it the positive claims
// pass over an instrument that cannot see the defect at all.

import { act, render } from "@testing-library/react";
import { useMemo } from "react";
import { describe, expect, it } from "vitest";

import { SidekicksBridgeProvider } from "../bridge/index.js";
// This family's own settle, rather than `core/`'s: the attention read goes through
// the console's one refresh scheduler, so its first read lands a debounce interval
// after the subscribe — measured on the wall clock, because the bridge these cases
// build carries no scenario engine. A second copy of that wait here would be free to
// disagree with the destination's about how many passes the chain needs.
import { settle } from "./session-surface.test-support.js";
import { FrameStore, type SessionStore, type SessionStoreRegistry } from "../store/index.js";
import type { FrameBindingContext } from "../seats/index.js";
import { SessionAttentionBinding } from "./SessionAttentionBinding.js";
import { useAttentionProjection, useRailAttentionPublisher } from "./notifications/index.js";
import { attentionProjectionReaderFor } from "./notifications/index.js";

/** Two sessions the node reports, one of them with something waiting on a person. */
const NODE_SESSION_IDS: readonly string[] = ["session-a", "session-b"];

/** The sessions whose projection answers with an actionable item. */
const WAITING_SESSION_IDS: readonly string[] = ["session-a"];

/**
 * A growth port answering the two reads this binding puts, and nothing else.
 *
 * Cast rather than constructed, on `session-surface.test-support.tsx`' rule: the port
 * declares every operation the console has a slate row for, and building all of them
 * to answer two would make the setup the subject.
 */
function growthPortServing(options: { readonly waitingSessionIds: readonly string[] }): unknown {
  return {
    sessionList: () =>
      Promise.resolve({
        status: "served",
        value: NODE_SESSION_IDS.map((sessionId) => ({ sessionId, state: "active" })),
      }),
    attentionProjectionRead: ({ sessionId }: { readonly sessionId: string }) =>
      Promise.resolve({
        status: "served",
        value: {
          items: options.waitingSessionIds.includes(sessionId)
            ? [
                {
                  id: `item-${sessionId}`,
                  sessionId,
                  trigger: "pending_approval",
                  severity: "actionable",
                  summary: "waiting on you",
                  sourceEventId: `event-${sessionId}`,
                  createdAt: "2026-01-01T10:00:00.000Z",
                },
              ]
            : [],
        },
      }),
  };
}

/** A registry holding no store, which is all these reads ask of it. */
function emptyRegistry(): SessionStoreRegistry {
  return {
    openSessionIds: [],
    peek: (): SessionStore | undefined => undefined,
    subscribe: () => () => undefined,
  } as unknown as SessionStoreRegistry;
}

interface Harness {
  readonly frameStore: FrameStore;
  readonly context: FrameBindingContext;
  readonly bridge: unknown;
}

function harness(options: { readonly waitingSessionIds?: readonly string[] } = {}): Harness {
  const frameStore = new FrameStore();
  const sessionStoreRegistry = emptyRegistry();
  const bridge = {
    source: "fixture",
    growth: growthPortServing({
      waitingSessionIds: options.waitingSessionIds ?? WAITING_SESSION_IDS,
    }),
  };
  return {
    frameStore,
    bridge,
    context: {
      bridge,
      frameStore,
      sessionStoreRegistry,
    } as unknown as FrameBindingContext,
  };
}

/** What the rail would draw, read from the store the rail reads. */
function railCount(frameStore: FrameStore): number | undefined {
  return frameStore.getState().railAttentionCount;
}

describe("the window's attention binding — the count outlives a destination", () => {
  it("publishes the count once the read settles", async () => {
    // The floor. Without it every claim below could be satisfied by a binding that
    // never published anything, since `undefined` is also what a cleared count reads.
    const { bridge, context, frameStore } = harness();

    render(
      <SidekicksBridgeProvider bridge={bridge as never}>
        <SessionAttentionBinding context={context}>
          <div>the sessions destination</div>
        </SessionAttentionBinding>
      </SidekicksBridgeProvider>,
    );
    await settle();

    expect(railCount(frameStore)).toBe(1);
  });

  it("keeps it while the subtree under it is replaced — the navigation", async () => {
    // The defect, stated as a case: the child is what a route swaps, and the count has
    // to be the same number on both sides of the swap. Mounted on the destination this
    // reads `undefined` after the re-render.
    const { bridge, context, frameStore } = harness();

    const mounted = render(
      <SidekicksBridgeProvider bridge={bridge as never}>
        <SessionAttentionBinding context={context}>
          <div>the sessions destination</div>
        </SessionAttentionBinding>
      </SidekicksBridgeProvider>,
    );
    await settle();
    const beforeNavigation = railCount(frameStore);

    mounted.rerender(
      <SidekicksBridgeProvider bridge={bridge as never}>
        <SessionAttentionBinding context={context}>
          <div>the workspace</div>
        </SessionAttentionBinding>
      </SidekicksBridgeProvider>,
    );
    await settle();

    expect(beforeNavigation).toBe(1);
    expect(railCount(frameStore)).toBe(1);
    expect(mounted.container.textContent).toContain("the workspace");
  });

  it("clears it when the window loses its bridge and the frame comes down", async () => {
    // The other end of the lifetime. A window whose bridge resolution goes unavailable
    // renders the bare card and mounts no frame, so the binding unmounts — and a count
    // left standing after the read that produced it went away is the stale number the
    // rail refuses. Unmounting is how that arrives here.
    const { bridge, context, frameStore } = harness();

    const mounted = render(
      <SidekicksBridgeProvider bridge={bridge as never}>
        <SessionAttentionBinding context={context}>
          <div>the sessions destination</div>
        </SessionAttentionBinding>
      </SidekicksBridgeProvider>,
    );
    await settle();
    const whileHeld = railCount(frameStore);

    await act(async () => {
      mounted.unmount();
    });

    expect(whileHeld).toBe(1);
    expect(railCount(frameStore)).toBeUndefined();
  });

  it("says nothing rather than zero when the node has nothing waiting", async () => {
    // The suppression rule reaching the store rather than only the fold: a healthy
    // console is the common case, and a `0` badge on the most-seen surface in the
    // product would be permanent furniture reporting the absence of news.
    const { bridge, context, frameStore } = harness({ waitingSessionIds: [] });

    render(
      <SidekicksBridgeProvider bridge={bridge as never}>
        <SessionAttentionBinding context={context}>
          <div>the sessions destination</div>
        </SessionAttentionBinding>
      </SidekicksBridgeProvider>,
    );
    await settle();

    expect(railCount(frameStore)).toBeUndefined();
  });

  it("planted control: the same read mounted on the destination loses the count", async () => {
    // The old shape, planted. It publishes the same number from the same hooks and
    // differs in one thing only — where it is mounted — so a swap that leaves the
    // binding's count standing takes this one to nothing. Without this case the two
    // claims above would pass over an instrument that could not tell the two shapes
    // apart.
    const { bridge, context, frameStore } = harness();

    function DestinationHoldingTheRead(): React.JSX.Element {
      const projection = useAttentionProjection(
        // Memoised exactly as the destination memoised it. A fresh reader identity per
        // render rebuilds the read every pass and it never settles at all, which would
        // make this control pass for a reason that has nothing to do with lifetime.
        useMemo(() => attentionProjectionReaderFor(context.bridge.growth, NODE_SESSION_IDS), []),
        context.sessionStoreRegistry,
      );
      useRailAttentionPublisher(frameStore, projection.reading);
      return <div>the sessions destination</div>;
    }

    const mounted = render(
      <SidekicksBridgeProvider bridge={bridge as never}>
        <DestinationHoldingTheRead />
      </SidekicksBridgeProvider>,
    );
    await settle();
    const whileMounted = railCount(frameStore);

    mounted.rerender(
      <SidekicksBridgeProvider bridge={bridge as never}>
        <div>the workspace</div>
      </SidekicksBridgeProvider>,
    );
    await settle();

    expect(whileMounted).toBe(1);
    expect(railCount(frameStore)).toBeUndefined();
  });
});
