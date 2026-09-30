// The settings mount arms one walk over its own board and releases it with itself. This is the
// binding's lifetime; the walking itself is `components/LazyBody/lazy-body-warm.ts`'s. A
// binding can fail by walking again on every render, by re-arming against a board whose screen
// has unmounted, or by going cold silently under the `StrictMode` replay.

import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";

// Deep import, as every `.test-support` consumer does.
import { ManualIdleWarmScheduler } from "@test/helpers/idle-warm.js";
import { SettingsPageRegistry } from "../settings-pages.js";
import type { SettingsPageContext } from "../types.js";
import { useSettingsPageIdleWarm } from "./useSettingsPageIdleWarm.js";

/** A board holding one deferred page that records its load, and one with nothing to load. */
function composePages(loadedSections: string[]): SettingsPageRegistry {
  const pages = new SettingsPageRegistry();
  pages.register({
    section: "notifications",
    owner: "settings-warm-test",
    label: "Notifications",
    keywords: [],
    body: () => {
      loadedSections.push("notifications");
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

/** A component that does nothing but hold the binding, so the effect is the subject. */
function WarmingSettingsScreen(props: {
  readonly pages: SettingsPageRegistry;
  readonly scheduler: ManualIdleWarmScheduler;
}): React.JSX.Element {
  useSettingsPageIdleWarm(props.pages, props.scheduler);
  return <div />;
}

describe("the settings page board's idle warm", () => {
  it("arms one walk on mount, and at idle warms only the deferred page", () => {
    const loadedSections: string[] = [];
    const pages = composePages(loadedSections);
    const scheduler = new ManualIdleWarmScheduler();
    render(<WarmingSettingsScreen pages={pages} scheduler={scheduler} />);

    expect(scheduler.pendingCount).toBe(1);
    expect(loadedSections).toStrictEqual([]);

    scheduler.runToQuiescence();

    // A `render:` page has nothing to fetch, so the walk ends rather than re-arming on it.
    expect(loadedSections).toStrictEqual(["notifications"]);
    expect(pages.unloadedKeys()).toStrictEqual([]);
  });

  it("does not re-arm when the screen re-renders", () => {
    // The walk is built inside the effect, whose dependencies are the board and a pinned
    // scheduler. Depending on the scheduler parameter instead would re-run the effect every
    // pass, since its default constructs one per render.
    const loadedSections: string[] = [];
    const pages = composePages(loadedSections);
    const scheduler = new ManualIdleWarmScheduler();
    const rendered = render(<WarmingSettingsScreen pages={pages} scheduler={scheduler} />);
    rendered.rerender(<WarmingSettingsScreen pages={pages} scheduler={scheduler} />);
    rendered.rerender(<WarmingSettingsScreen pages={pages} scheduler={scheduler} />);

    expect(scheduler.pendingCount).toBe(1);
    scheduler.runToQuiescence();
    expect(loadedSections).toStrictEqual(["notifications"]);
  });

  it("releases the walk when the screen goes away", () => {
    // Guards the leak of a window closed mid-walk still re-arming an idle callback.
    const loadedSections: string[] = [];
    const pages = composePages(loadedSections);
    const scheduler = new ManualIdleWarmScheduler();
    const rendered = render(<WarmingSettingsScreen pages={pages} scheduler={scheduler} />);

    act(() => {
      rendered.unmount();
    });

    expect(scheduler.canceledHandles).toHaveLength(1);
    expect(scheduler.pendingCount).toBe(0);
    scheduler.runToQuiescence();
    expect(loadedSections).toStrictEqual([]);
  });

  it("warms the board under a replayed effect", () => {
    // `StrictMode` runs setup, cleanup, then setup again. A walk held across the replay would be
    // started, canceled and then found already canceled, leaving the board cold with nothing
    // failing; building it inside each setup makes a replay a fresh walk.
    const loadedSections: string[] = [];
    const pages = composePages(loadedSections);
    const scheduler = new ManualIdleWarmScheduler();
    render(
      <StrictMode>
        <WarmingSettingsScreen pages={pages} scheduler={scheduler} />
      </StrictMode>,
    );

    // The replay's cleanup canceled the first walk, so exactly one is armed.
    expect(scheduler.pendingCount).toBe(1);

    scheduler.runToQuiescence();

    expect(loadedSections).toStrictEqual(["notifications"]);
    expect(pages.unloadedKeys()).toStrictEqual([]);
  });
});
