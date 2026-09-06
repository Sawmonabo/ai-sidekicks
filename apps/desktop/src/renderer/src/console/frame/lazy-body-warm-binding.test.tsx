// The window arms both walks after its first frame, and releases them with itself.
//
// The claim is the LIFETIME rather than the walking, which `seats/lazy-body-warm.test.ts`
// already holds. What can go wrong here is a walk that never starts (an effect that
// closed over a stale board), a walk that starts twice (a frame that re-rendered and
// rebuilt the pair), and — the one that leaves no trace until an auxiliary window closes
// — a walk still re-arming against a board its window no longer reads.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ConsolePaneRegistry,
  ConsoleSurfaceRegistry,
  type ConsolePaneContext,
  type ConsoleSurfaceContext,
} from "../seats/index.js";
// Deeply, as every consumer of a `.test-support` module does: a helper that exists for
// suites belongs to the module beside it and not on the family's production door.
import { ManualIdleWarmScheduler } from "../seats/idle-warm.test-support.js";
import { useLazyBodyIdleWarm } from "./lazy-body-warm-binding.js";

/** A window's two boards, each holding one loader-backed body that records its load. */
function composeBoards(loaded: string[]): {
  readonly paneRegistry: ConsolePaneRegistry;
  readonly surfaceRegistry: ConsoleSurfaceRegistry;
} {
  const paneRegistry = new ConsolePaneRegistry();
  paneRegistry.register({
    kind: "diff",
    owner: "repos-family",
    body: () => {
      loaded.push("pane:diff");
      return Promise.resolve<{ Body: (context: ConsolePaneContext) => React.ReactNode }>({
        Body: () => null,
      });
    },
  });
  const surfaceRegistry = new ConsoleSurfaceRegistry();
  surfaceRegistry.register({
    slot: "settings",
    owner: "settings-family",
    body: () => {
      loaded.push("surface:settings");
      return Promise.resolve<{ Body: (context: ConsoleSurfaceContext) => React.ReactNode }>({
        Body: () => null,
      });
    },
  });
  return { paneRegistry, surfaceRegistry };
}

/** A frame that does nothing but hold the binding, so the effect is the subject. */
function WarmingFrame(props: {
  readonly paneRegistry: ConsolePaneRegistry;
  readonly surfaceRegistry: ConsoleSurfaceRegistry;
  readonly scheduler: ManualIdleWarmScheduler;
}): React.JSX.Element {
  useLazyBodyIdleWarm(props.paneRegistry, props.surfaceRegistry, props.scheduler);
  return <div />;
}

describe("the window's idle warm", () => {
  it("arms one walk per board once the frame has mounted", () => {
    const loaded: string[] = [];
    const boards = composeBoards(loaded);
    const scheduler = new ManualIdleWarmScheduler();
    render(<WarmingFrame {...boards} scheduler={scheduler} />);

    // Two walks, one step armed each, and nothing fetched yet: the walk waits for an
    // idle callback rather than doing its work in the effect that armed it.
    expect(scheduler.pendingCount).toBe(2);
    expect(loaded).toStrictEqual([]);
  });

  it("warms both boards when the host goes idle", () => {
    const loaded: string[] = [];
    const boards = composeBoards(loaded);
    const scheduler = new ManualIdleWarmScheduler();
    render(<WarmingFrame {...boards} scheduler={scheduler} />);

    scheduler.runToQuiescence();

    expect([...loaded].sort()).toStrictEqual(["pane:diff", "surface:settings"]);
    expect(boards.paneRegistry.unloadedKeys()).toStrictEqual([]);
    expect(boards.surfaceRegistry.unloadedKeys()).toStrictEqual([]);
  });

  it("does not re-arm when the frame re-renders", () => {
    // The pair is held in state rather than rebuilt per render: the once-per-instance
    // rule is state on the walk, so a pair rebuilt each pass would start a new walk
    // every time anything above it changed.
    const loaded: string[] = [];
    const boards = composeBoards(loaded);
    const scheduler = new ManualIdleWarmScheduler();
    const rendered = render(<WarmingFrame {...boards} scheduler={scheduler} />);
    rendered.rerender(<WarmingFrame {...boards} scheduler={scheduler} />);
    rendered.rerender(<WarmingFrame {...boards} scheduler={scheduler} />);

    expect(scheduler.pendingCount).toBe(2);
    scheduler.runToQuiescence();
    expect(loaded).toHaveLength(2);
  });

  it("releases both walks when the window goes away", () => {
    // The leak this is for: an auxiliary window that closed while its walk was mid-board
    // would go on re-arming an idle callback against a board nothing reads.
    const loaded: string[] = [];
    const boards = composeBoards(loaded);
    const scheduler = new ManualIdleWarmScheduler();
    const rendered = render(<WarmingFrame {...boards} scheduler={scheduler} />);

    act(() => {
      rendered.unmount();
    });

    expect(scheduler.cancelledHandles).toHaveLength(2);
    expect(scheduler.pendingCount).toBe(0);
    scheduler.runToQuiescence();
    expect(loaded).toStrictEqual([]);
  });

  it("negative control: boards nobody mounted a frame over are never warmed", () => {
    // Without this, every case above would pass over a walk that began in the registry
    // rather than in the window — and unmounting would then stop nothing.
    const loaded: string[] = [];
    const boards = composeBoards(loaded);
    const scheduler = new ManualIdleWarmScheduler();
    scheduler.runToQuiescence();
    expect(loaded).toStrictEqual([]);
    expect(boards.paneRegistry.unloadedKeys()).toStrictEqual(["diff"]);
    expect(boards.surfaceRegistry.unloadedKeys()).toStrictEqual(["settings"]);
  });
});
