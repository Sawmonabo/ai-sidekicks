// The window arms both walks after its first frame, and releases them with itself.
//
// The claim is the LIFETIME rather than the walking, which `components/LazyBody/lazy-body-warm.test.ts`
// already holds. What can go wrong here is a walk that never starts (an effect that
// closed over a stale board), a walk that starts twice (a frame that re-rendered and
// rebuilt the pair), and — the one that leaves no trace until an auxiliary window closes
// — a walk still re-arming against a board its window no longer reads.

import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";

import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { ScreenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";
// Deeply, as every consumer of a `.test-support` module does: a helper that exists for
// suites belongs to the module beside it and not on the production index.
import { ManualIdleWarmScheduler } from "@test/helpers/idle-warm.js";
import { useLazyBodyIdleWarm } from "./useLazyBodyIdleWarm.js";

/** A window's two boards, each holding one loader-backed body that records its load. */
function composeBoards(loaded: string[]): {
  readonly paneRegistry: PaneRegistry;
  readonly screenRegistry: ScreenRegistry;
} {
  const paneRegistry = new PaneRegistry();
  paneRegistry.register({
    kind: "diff",
    owner: "repos",
    body: () => {
      loaded.push("pane:diff");
      return Promise.resolve<{ Body: (context: PaneContext) => React.ReactNode }>({
        Body: () => null,
      });
    },
  });
  const screenRegistry = new ScreenRegistry();
  screenRegistry.register({
    name: "settings",
    owner: "settings",
    body: () => {
      loaded.push("screen:settings");
      return Promise.resolve<{ Body: (context: ScreenContext) => React.ReactNode }>({
        Body: () => null,
      });
    },
  });
  return { paneRegistry, screenRegistry };
}

/** A frame that does nothing but hold the binding, so the effect is the subject. */
function WarmingFrame(props: {
  readonly paneRegistry: PaneRegistry;
  readonly screenRegistry: ScreenRegistry;
  readonly scheduler: ManualIdleWarmScheduler;
}): React.JSX.Element {
  useLazyBodyIdleWarm(props.paneRegistry, props.screenRegistry, props.scheduler);
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

    expect([...loaded].sort()).toStrictEqual(["pane:diff", "screen:settings"]);
    expect(boards.paneRegistry.unloadedKeys()).toStrictEqual([]);
    expect(boards.screenRegistry.unloadedKeys()).toStrictEqual([]);
  });

  it("does not re-arm when the frame re-renders", () => {
    // The walks are built inside the effect, whose dependencies are the two boards and
    // a pinned scheduler — none of which a re-render changes. Naming the scheduler
    // PARAMETER as the dependency instead would re-run the effect on every pass, because
    // its default constructs one per render, and start a new walk each time.
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

    expect(scheduler.canceledHandles).toHaveLength(2);
    expect(scheduler.pendingCount).toBe(0);
    scheduler.runToQuiescence();
    expect(loaded).toStrictEqual([]);
  });

  it("warms both boards under a replayed effect", () => {
    // `StrictMode` runs every effect setup, its cleanup, and the setup again. Holding
    // the walks across that replay was silently fatal: the first setup started them, the
    // synthetic cleanup CANCELED them, and the replayed setup found the same objects
    // already started and already canceled and returned — so both boards stayed cold
    // for the life of the window, with nothing failing and nothing logged. Building the
    // pair inside each setup is what makes a replay a fresh pair.
    const loaded: string[] = [];
    const boards = composeBoards(loaded);
    const scheduler = new ManualIdleWarmScheduler();
    render(
      <StrictMode>
        <WarmingFrame {...boards} scheduler={scheduler} />
      </StrictMode>,
    );

    // The replay's own cleanup canceled the first pair, so exactly one live pair is
    // armed — a count that also fails if the fix had left BOTH pairs walking.
    expect(scheduler.pendingCount).toBe(2);

    scheduler.runToQuiescence();

    expect([...loaded].sort()).toStrictEqual(["pane:diff", "screen:settings"]);
    expect(boards.paneRegistry.unloadedKeys()).toStrictEqual([]);
    expect(boards.screenRegistry.unloadedKeys()).toStrictEqual([]);
  });

  it("releases the replayed pair when the window goes away", () => {
    // The lifetime claim, re-asked over the replay: whichever pair is live at unmount is
    // the pair that gets canceled, and nothing walks afterwards.
    const loaded: string[] = [];
    const boards = composeBoards(loaded);
    const scheduler = new ManualIdleWarmScheduler();
    const rendered = render(
      <StrictMode>
        <WarmingFrame {...boards} scheduler={scheduler} />
      </StrictMode>,
    );

    act(() => {
      rendered.unmount();
    });

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
    expect(boards.screenRegistry.unloadedKeys()).toStrictEqual(["settings"]);
  });
});
