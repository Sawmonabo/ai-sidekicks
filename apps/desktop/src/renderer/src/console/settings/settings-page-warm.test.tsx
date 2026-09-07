// The settings mount arms one walk over its own board, and releases it with itself.
//
// The claim here is the LIFETIME rather than the walking, which `seats/lazy-body-warm.test.ts`
// already holds, and rather than the wiring, which `SettingsSurface.page-warm.test.tsx`
// holds through the surface. What can go wrong in a binding is a walk that starts again on
// every render, one still re-arming against a board whose surface has unmounted — the leak
// that leaves no trace until a second settings window is opened and closed — and the
// `StrictMode` replay, which fails silently in the one direction that matters: the board
// simply stays cold and nothing reports it.

import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";

// Deeply, as every consumer of a `.test-support` module does: a helper that exists for
// suites belongs to the module beside it and not on the family's production door.
import { ManualIdleWarmScheduler } from "../seats/idle-warm.test-support.js";
import { SettingsPageRegistry, type SettingsPageContext } from "./settings-page-registry.js";
import { useSettingsPageIdleWarm } from "./settings-page-warm.js";

/** A board holding one deferred page that records its load, and one with nothing to load. */
function composePages(loadedSections: string[]): SettingsPageRegistry {
  const pages = new SettingsPageRegistry();
  pages.register({
    section: "sidekicks",
    owner: "settings-warm-test",
    label: "Sidekicks",
    keywords: [],
    body: () => {
      loadedSections.push("sidekicks");
      return Promise.resolve<{ Body: (context: SettingsPageContext) => React.ReactNode }>({
        Body: () => null,
      });
    },
  });
  pages.register({
    section: "keyboard",
    owner: "settings-warm-test",
    label: "Keyboard",
    keywords: [],
    render: () => null,
  });
  return pages;
}

/** A surface that does nothing but hold the binding, so the effect is the subject. */
function WarmingSettingsSurface(props: {
  readonly pages: SettingsPageRegistry;
  readonly scheduler: ManualIdleWarmScheduler;
}): React.JSX.Element {
  useSettingsPageIdleWarm(props.pages, props.scheduler);
  return <div />;
}

describe("the settings page board's idle warm", () => {
  it("arms one walk once the surface has mounted, and fetches nothing yet", () => {
    const loadedSections: string[] = [];
    const pages = composePages(loadedSections);
    const scheduler = new ManualIdleWarmScheduler();
    render(<WarmingSettingsSurface pages={pages} scheduler={scheduler} />);

    expect(scheduler.pendingCount).toBe(1);
    expect(loadedSections).toStrictEqual([]);
  });

  it("warms the deferred page when the host goes idle, and asks nothing of the other", () => {
    const loadedSections: string[] = [];
    const pages = composePages(loadedSections);
    const scheduler = new ManualIdleWarmScheduler();
    render(<WarmingSettingsSurface pages={pages} scheduler={scheduler} />);

    scheduler.runToQuiescence();

    // A `render:` page has nothing to fetch, so the walk ends rather than re-arming on it.
    expect(loadedSections).toStrictEqual(["sidekicks"]);
    expect(pages.unloadedKeys()).toStrictEqual([]);
  });

  it("does not re-arm when the surface re-renders", () => {
    // The walk is built inside the effect, whose dependencies are the board and a pinned
    // scheduler — neither of which a re-render changes. Naming the scheduler PARAMETER as
    // the dependency instead would re-run the effect every pass, because its default
    // constructs one per render, and start a fresh walk each time.
    const loadedSections: string[] = [];
    const pages = composePages(loadedSections);
    const scheduler = new ManualIdleWarmScheduler();
    const rendered = render(<WarmingSettingsSurface pages={pages} scheduler={scheduler} />);
    rendered.rerender(<WarmingSettingsSurface pages={pages} scheduler={scheduler} />);
    rendered.rerender(<WarmingSettingsSurface pages={pages} scheduler={scheduler} />);

    expect(scheduler.pendingCount).toBe(1);
    scheduler.runToQuiescence();
    expect(loadedSections).toStrictEqual(["sidekicks"]);
  });

  it("releases the walk when the surface goes away", () => {
    // The leak this is for: a settings window closed mid-walk would go on re-arming an
    // idle callback against a board that nothing reads any more.
    const loadedSections: string[] = [];
    const pages = composePages(loadedSections);
    const scheduler = new ManualIdleWarmScheduler();
    const rendered = render(<WarmingSettingsSurface pages={pages} scheduler={scheduler} />);

    act(() => {
      rendered.unmount();
    });

    expect(scheduler.cancelledHandles).toHaveLength(1);
    expect(scheduler.pendingCount).toBe(0);
    scheduler.runToQuiescence();
    expect(loadedSections).toStrictEqual([]);
  });

  it("warms the board under a replayed effect", () => {
    // `StrictMode` runs every effect setup, its cleanup, and the setup again. A walk held
    // across that replay is silently fatal: the first setup starts it, the synthetic
    // cleanup cancels it, and the replayed setup finds the same object already started and
    // already cancelled and returns — so the board stays cold for the life of the surface
    // with nothing failing and nothing logged. Building it inside each setup is what makes
    // a replay a fresh walk.
    const loadedSections: string[] = [];
    const pages = composePages(loadedSections);
    const scheduler = new ManualIdleWarmScheduler();
    render(
      <StrictMode>
        <WarmingSettingsSurface pages={pages} scheduler={scheduler} />
      </StrictMode>,
    );

    // The replay's own cleanup cancelled the first walk, so exactly one is armed — a count
    // that also fails if the fix had left both of them walking.
    expect(scheduler.pendingCount).toBe(1);

    scheduler.runToQuiescence();

    expect(loadedSections).toStrictEqual(["sidekicks"]);
    expect(pages.unloadedKeys()).toStrictEqual([]);
  });

  it("negative control: a board nobody bound the walk to is never warmed", () => {
    // Without this, every case above would pass over a registry that warmed itself on
    // registration — and unmounting would then stop nothing.
    const loadedSections: string[] = [];
    const pages = composePages(loadedSections);
    const scheduler = new ManualIdleWarmScheduler();

    scheduler.runToQuiescence();

    expect(loadedSections).toStrictEqual([]);
    expect(pages.unloadedKeys()).toStrictEqual(["sidekicks"]);
  });
});
