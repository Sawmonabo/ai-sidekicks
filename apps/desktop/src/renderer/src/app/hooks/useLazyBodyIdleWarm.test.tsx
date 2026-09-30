// The window arms both walks after its first frame and releases them with itself. The claim is
// the lifetime, not the walking (`lazy-body-warm.test.ts` holds that): a walk that never starts,
// starts twice, or keeps re-arming against a board its window no longer reads.

import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";

import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { ScreenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";
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

    // One step armed per walk, and nothing fetched until an idle callback runs.
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
    // The effect depends on the boards and a pinned scheduler, which a re-render leaves alone;
    // depending on the scheduler parameter would start a new walk each pass.
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
    // A window closed mid-walk must not keep re-arming an idle callback against a dead board.
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
    // `StrictMode` replays each effect setup. Walks held across the replay would be started and
    // then canceled, leaving both boards cold with nothing failing; building the pair inside
    // each setup makes a replay a fresh pair.
    const loaded: string[] = [];
    const boards = composeBoards(loaded);
    const scheduler = new ManualIdleWarmScheduler();
    render(
      <StrictMode>
        <WarmingFrame {...boards} scheduler={scheduler} />
      </StrictMode>,
    );

    // The replay canceled the first pair, so exactly one live pair is armed.
    expect(scheduler.pendingCount).toBe(2);

    scheduler.runToQuiescence();

    expect([...loaded].sort()).toStrictEqual(["pane:diff", "screen:settings"]);
    expect(boards.paneRegistry.unloadedKeys()).toStrictEqual([]);
    expect(boards.screenRegistry.unloadedKeys()).toStrictEqual([]);
  });

  it("releases the replayed pair when the window goes away", () => {
    // Whichever pair is live at unmount is canceled, and nothing walks afterwards.
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
    // Without this, the cases above would pass over a walk that began in the registry rather
    // than in the window.
    const loaded: string[] = [];
    const boards = composeBoards(loaded);
    const scheduler = new ManualIdleWarmScheduler();
    scheduler.runToQuiescence();
    expect(loaded).toStrictEqual([]);
    expect(boards.paneRegistry.unloadedKeys()).toStrictEqual(["diff"]);
    expect(boards.screenRegistry.unloadedKeys()).toStrictEqual(["settings"]);
  });
});
