// Plan-003 Phase 5 T5.1 — WHEN the roster's rows change, and under which subject.
//
// The other half of the split: `NodeRoster.render.test.tsx` holds what the rows say,
// and this file holds `node-roster-reads.ts` driven through the component — the
// push-triggered refresh, the two independent staleness guards, and the (session,
// transport) subject the held roster is stamped with. Both mount through the shared
// seam builder in `node-roster.test-support.ts`.
//
// EVERY CASE DRIVES A SUPPLIED SEAM, because there is no other arm: `reads` is
// required, and the view names no wire. The transport cases below are what make that
// prop load-bearing rather than ceremonial — a host REPLACES its bridge without
// remounting anything, and the session id does not move when it does.

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeNodeRosterResponse } from "@ai-sidekicks/contracts";

import { NodeRoster } from "../NodeRoster.js";
import {
  AT_FLOOR_NODE_ID,
  FIRST_SESSION_ID,
  FIRST_SNAPSHOT,
  JOINED_LATER_NODE_ID,
  REGISTERING_NODE_ID,
  SECOND_SESSION_ID,
  SECOND_SESSION_NODE_ID,
  SECOND_SESSION_SNAPSHOT,
  SECOND_SNAPSHOT,
  createDeferred,
  createDrivenSeam,
  seamServing,
} from "./node-roster.test-support.js";

describe("NodeRoster reads", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("presence-push refresh", () => {
    it("re-reads the roster when a presence transition arrives", async () => {
      const seam = createDrivenSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
      });
      seam.readRoster.mockResolvedValueOnce(FIRST_SNAPSHOT).mockResolvedValueOnce(SECOND_SNAPSHOT);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
      await screen.findByText(`node id: ${AT_FLOOR_NODE_ID}`);

      act(() => {
        seam.emitPresenceChange();
      });

      await screen.findByText(`node id: ${JOINED_LATER_NODE_ID}`);
      expect(seam.readRoster).toHaveBeenCalledTimes(2);
      // The node that went offline is still ON the roster — offline is a rendered
      // state, not a removal.
      const offlineRow = screen
        .getByLabelText("node-roster-loaded")
        .querySelector('li[data-node-state="offline"]');
      expect(offlineRow).not.toBeNull();
      expect(screen.queryByText(`node id: ${REGISTERING_NODE_ID}`)).toBeNull();
    });

    it("does not flicker back to loading while the re-read is in flight", async () => {
      // The no-flicker contract: a refresh keeps the last good snapshot on screen
      // until the new one lands. Resetting to `loading` on every push would blank a
      // live roster on every heartbeat.
      const heldReRead = createDeferred<RuntimeNodeRosterResponse>();
      const seam = createDrivenSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
      });
      seam.readRoster.mockResolvedValueOnce(FIRST_SNAPSHOT).mockReturnValueOnce(heldReRead.promise);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
      const firstRow = await screen.findByText(`node id: ${AT_FLOOR_NODE_ID}`);

      act(() => {
        seam.emitPresenceChange();
      });

      expect(screen.queryByLabelText("node-roster-loading")).toBeNull();
      // The SAME node, not merely an equal one: an unmount-and-remount between reads
      // is the flash this contract forbids, and re-querying by text alone could not
      // tell the two apart.
      expect(screen.getByText(`node id: ${AT_FLOOR_NODE_ID}`)).toBe(firstRow);

      await act(async () => {
        heldReRead.resolve(SECOND_SNAPSHOT);
        await heldReRead.promise;
      });
      expect(screen.getByText(`node id: ${JOINED_LATER_NODE_ID}`)).toBeDefined();
      expect(seam.readRoster).toHaveBeenCalledTimes(2);
    });

    it("drops a stale in-flight read that settles after a newer one", async () => {
      // Out-of-order guard: read #1 (mount) and read #2 (presence push) are both in
      // flight; #2 settles FIRST, then #1. The older response must not overwrite the
      // newer roster.
      const firstRead = createDeferred<RuntimeNodeRosterResponse>();
      const secondRead = createDeferred<RuntimeNodeRosterResponse>();
      const seam = createDrivenSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
      });
      seam.readRoster
        .mockReturnValueOnce(firstRead.promise)
        .mockReturnValueOnce(secondRead.promise);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
      act(() => {
        seam.emitPresenceChange();
      });
      expect(seam.readRoster).toHaveBeenCalledTimes(2);

      await act(async () => {
        secondRead.resolve(SECOND_SNAPSHOT);
        await secondRead.promise;
      });
      expect(screen.getByText(`node id: ${JOINED_LATER_NODE_ID}`)).toBeDefined();

      await act(async () => {
        firstRead.resolve(FIRST_SNAPSHOT);
        await firstRead.promise;
      });
      // Still the NEWER snapshot: the stale response was discarded.
      expect(screen.getByText(`node id: ${JOINED_LATER_NODE_ID}`)).toBeDefined();
      expect(screen.queryByText(`node id: ${REGISTERING_NODE_ID}`)).toBeNull();
    });
  });

  describe("lifecycle", () => {
    it("resets to loading and re-reads when the session prop changes", async () => {
      const seam = createDrivenSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
      });
      seam.readRoster
        .mockResolvedValueOnce(FIRST_SNAPSHOT)
        .mockResolvedValueOnce(SECOND_SESSION_SNAPSHOT);

      const { rerender } = render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
      await screen.findByText(`node id: ${AT_FLOOR_NODE_ID}`);

      rerender(<NodeRoster sessionId={SECOND_SESSION_ID} reads={seam.reads} />);

      // The prior session's roster must not linger as if it were this one's.
      expect(screen.getByLabelText("node-roster-loading")).toBeDefined();
      expect(screen.queryByText(`node id: ${AT_FLOOR_NODE_ID}`)).toBeNull();

      await screen.findByText(`node id: ${SECOND_SESSION_NODE_ID}`);
      expect(seam.readRoster).toHaveBeenLastCalledWith({ sessionId: SECOND_SESSION_ID });
    });

    it("releases the presence subscription on unmount", async () => {
      const unsubscribeSpy = vi.fn();
      const seam = createDrivenSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
        unsubscribe: unsubscribeSpy,
      });

      const { unmount } = render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
      await screen.findByLabelText("node-roster-loaded");

      unmount();

      expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    it("drops the previous session's read when it settles after the session switched", async () => {
      // The per-effect `cancelled` flag, which is a DIFFERENT guard from the
      // per-effect `latestRequestSequence` counter: the sequence counter is
      // re-created by the new session's effect, so it cannot recognize the old
      // session's response as stale. Only the retired effect's own `cancelled` flag
      // stops session A's late roster from being painted into session B's view — a
      // cross-session data leak, not merely a stale render.
      const firstSessionRead = createDeferred<RuntimeNodeRosterResponse>();
      const secondSessionRead = createDeferred<RuntimeNodeRosterResponse>();
      const seam = createDrivenSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
      });
      seam.readRoster
        .mockReturnValueOnce(firstSessionRead.promise)
        .mockReturnValueOnce(secondSessionRead.promise);

      const { rerender } = render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
      rerender(<NodeRoster sessionId={SECOND_SESSION_ID} reads={seam.reads} />);

      await act(async () => {
        secondSessionRead.resolve(SECOND_SESSION_SNAPSHOT);
        await secondSessionRead.promise;
      });
      expect(screen.getByText(`node id: ${SECOND_SESSION_NODE_ID}`)).toBeDefined();

      await act(async () => {
        firstSessionRead.resolve(FIRST_SNAPSHOT);
        await firstSessionRead.promise;
      });
      // Session A's nodes never reach session B's roster.
      expect(screen.queryByText(`node id: ${AT_FLOOR_NODE_ID}`)).toBeNull();
      expect(screen.getByText(`node id: ${SECOND_SESSION_NODE_ID}`)).toBeDefined();
    });
  });

  describe("transport replacement", () => {
    it("follows the seam when a host replaces the transport under one session", async () => {
      // The console's bridge provider REPLACES its resolution as state without
      // remounting its children — a scenario swap, a supplied-bridge change, or a
      // disposed engine re-minted on a second mount. The session id does not move
      // through any of that, so the seam is the only signal there is; a roster that
      // ignored it would stay subscribed to a bridge that has been torn down and keep
      // showing its rows.
      const releaseFirstSeam = vi.fn();
      const firstSeam = createDrivenSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
        unsubscribe: releaseFirstSeam,
      });
      const secondSeam = seamServing(SECOND_SNAPSHOT);

      const { rerender } = render(
        <NodeRoster sessionId={FIRST_SESSION_ID} reads={firstSeam.reads} />,
      );
      await screen.findByText(`node id: ${REGISTERING_NODE_ID}`);

      rerender(<NodeRoster sessionId={FIRST_SESSION_ID} reads={secondSeam.reads} />);
      await screen.findByText(`node id: ${JOINED_LATER_NODE_ID}`);

      // Released, subscribed, and read — all three through the second transport.
      expect(releaseFirstSeam).toHaveBeenCalledTimes(1);
      expect(secondSeam.subscribePresence).toHaveBeenCalledTimes(1);
      expect(secondSeam.readRoster).toHaveBeenCalledWith({ sessionId: FIRST_SESSION_ID });
      // And the first transport is not asked again, which is the half a dependency
      // added without releasing the old subscription would fail.
      expect(firstSeam.readRoster).toHaveBeenCalledTimes(1);
      // The rows on screen come from the SECOND bridge: the first one's registering
      // node is gone rather than merely joined by the second's rows.
      expect(screen.queryByText(`node id: ${REGISTERING_NODE_ID}`)).toBeNull();
    });

    it("negative control: an unchanged seam re-rendered does not resubscribe", async () => {
      // The other half of the dependency, and the reason the seam is cached per
      // bridge rather than composed per render: this case is what a dependency on a
      // freshly built pair would fail, tearing the subscription down and re-opening
      // it on every render of whatever mounts the roster.
      const releaseSeam = vi.fn();
      const seam = createDrivenSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
        unsubscribe: releaseSeam,
      });

      const { rerender } = render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
      await screen.findByText(`node id: ${AT_FLOOR_NODE_ID}`);

      rerender(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
      rerender(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);

      expect(seam.subscribePresence).toHaveBeenCalledTimes(1);
      expect(seam.readRoster).toHaveBeenCalledTimes(1);
      expect(releaseSeam).not.toHaveBeenCalled();
    });

    it("stops showing the retired transport's roster, and never repaints it late", async () => {
      // The interval this case exists for: the effect already re-subscribes on a
      // transport swap, but the held roster used to survive it, and a refresh
      // deliberately never re-enters `loading` — so the retired bridge's rows stood on
      // screen until the replacement read settled, which is unbounded and may never
      // happen. The first assertion is made with NO settling pass, because settling
      // first is exactly what hid the defect.
      const heldRetiredReRead = createDeferred<RuntimeNodeRosterResponse>();
      const heldReplacementRead = createDeferred<RuntimeNodeRosterResponse>();
      const firstSeam = createDrivenSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
      });
      firstSeam.readRoster
        .mockResolvedValueOnce(FIRST_SNAPSHOT)
        .mockReturnValueOnce(heldRetiredReRead.promise);
      const secondSeam = createDrivenSeam({ readRoster: () => heldReplacementRead.promise });

      const { rerender } = render(
        <NodeRoster sessionId={FIRST_SESSION_ID} reads={firstSeam.reads} />,
      );
      await screen.findByText(`node id: ${REGISTERING_NODE_ID}`);
      // A second read is now IN FLIGHT on the transport about to be retired, so the
      // late-reply arm below has something real to land.
      act(() => {
        firstSeam.emitPresenceChange();
      });

      rerender(<NodeRoster sessionId={FIRST_SESSION_ID} reads={secondSeam.reads} />);

      expect(screen.getByLabelText("node-roster-loading")).toBeDefined();
      expect(screen.queryByText(`node id: ${REGISTERING_NODE_ID}`)).toBeNull();

      // The retired transport answers after the swap. Its rows are an answer to a
      // question this view is no longer asking, so nothing repaints.
      await act(async () => {
        heldRetiredReRead.resolve(FIRST_SNAPSHOT);
        await heldRetiredReRead.promise;
      });
      expect(screen.queryByText(`node id: ${REGISTERING_NODE_ID}`)).toBeNull();
      expect(screen.getByLabelText("node-roster-loading")).toBeDefined();

      // …and the replacement read still lands, so the substitution is a pause and not
      // a dead end.
      await act(async () => {
        heldReplacementRead.resolve(SECOND_SNAPSHOT);
        await heldReplacementRead.promise;
      });
      expect(screen.getByText(`node id: ${JOINED_LATER_NODE_ID}`)).toBeDefined();
    });

    it("negative control: an unchanged seam re-rendered keeps the roster it has", async () => {
      // Without this, both cases above would pass over a view that reset on every
      // render — the SAME node, not merely an equal one, because an unmount and
      // remount between renders is the flash the no-flicker contract forbids.
      const seam = seamServing(FIRST_SNAPSHOT);

      const { rerender } = render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
      const firstRow = await screen.findByText(`node id: ${REGISTERING_NODE_ID}`);

      rerender(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);

      expect(screen.queryByLabelText("node-roster-loading")).toBeNull();
      expect(screen.getByText(`node id: ${REGISTERING_NODE_ID}`)).toBe(firstRow);
    });
  });
});

describe("NodeRoster — a stream that could not be opened", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opens the conversation again when the failed arm's control is pressed", async () => {
    // The asymmetry this case exists for. A failed READ recovers on its own: the
    // subscription that survived pushes again and the next refresh publishes rows.
    // A subscribe that THREW leaves nothing to push, and the seam deliberately skips
    // the snapshot rather than rendering rows behind a dead channel — so the effect
    // re-runs only when the session or the transport moves, and neither moves when a
    // concurrency cap clears thirty seconds later.
    const seam = createDrivenSeam({
      readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
      subscribeThrows: new Error("event.subscribe refused: too many open streams"),
      subscribeFailureCount: 1,
    });

    render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
    const failure = await screen.findByRole("alert", { name: "node-roster-error" });
    expect(failure.textContent ?? "").toContain("too many open streams");
    // The read really was skipped, which is what makes the stream-open arm terminal.
    expect(seam.readRoster).not.toHaveBeenCalled();

    const tryAgain = screen.getByRole("button", { name: "Try again" });
    await act(async () => {
      tryAgain.click();
      await Promise.resolve();
    });

    await screen.findByText(`node id: ${AT_FLOOR_NODE_ID}`);
    expect(seam.subscribePresence).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("node-roster-error")).toBeNull();
  });

  it("negative control: the column offers no such control once it is listening", async () => {
    // Without this, the case above would hold for a column that drew the control on
    // every arm — a re-open offered beside rows that are already live, which costs a
    // subscribe and a read to arrive at the state the column is already in.
    const seam = seamServing(FIRST_SNAPSHOT);

    render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
    await screen.findByText(`node id: ${AT_FLOOR_NODE_ID}`);

    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("negative control: a refusal that has not cleared refuses the re-open too", async () => {
    // Without this, the first case would hold for a control that cleared the failed
    // arm on press whatever the seam then did — reporting a recovery that did not
    // happen, which is worse than the terminal state it replaced.
    const seam = createDrivenSeam({
      readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
      subscribeThrows: new Error("event.subscribe refused: too many open streams"),
    });

    render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
    await screen.findByRole("alert", { name: "node-roster-error" });

    await act(async () => {
      screen.getByRole("button", { name: "Try again" }).click();
      await Promise.resolve();
    });

    expect(seam.subscribePresence).toHaveBeenCalledTimes(2);
    await screen.findByRole("alert", { name: "node-roster-error" });
  });
});
