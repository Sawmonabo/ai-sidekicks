// The sidebar: every declared section, exactly one of them open, and an arrangement
// that survives the window closing.
//
// The failure this file exists for is the quiet one. A sidebar that rendered only the
// sections somebody had filled would, on a build where nobody has, be an empty column
// — and an empty column reads as "this session has no work", which is a claim nothing
// established. The second is the open-section rule going one way only: attention that
// never opens a section leaves a red item folded away, and a choice that never survives
// a restart makes the sidebar forget what a person was watching.

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario.js";
import { PERSISTED_VALUE_CLASSES } from "../../persistence/value-classes.js";
import { MemoryPersistenceAdapter } from "../../persistence/memory-adapter.js";
import { UiStateStore } from "../../persistence/index.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { SessionStore } from "../../store/index.js";
import {
  SIDEBAR_SECTION_IDS,
  SidebarSectionRegistry,
  type SidebarSectionId,
} from "../../seats/index.js";
import { MountedSidebarSeat } from "./sidebar-commands.js";
import {
  SIDEBAR_LAYOUT_RECORD_KEY,
  SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
  SIDEBAR_SECTION_LABELS,
  SIDEBAR_SNAPSHOT_HEADER_KEY,
} from "./sidebar-model.js";
import { useSidebarLayout } from "./sidebar-state.js";
import { SessionSidebar } from "./SessionSidebar.js";

const SESSION_ID = "session-sidebar";

const SCENARIO: ConsoleScenario = {
  id: "sidebar",
  label: "Sidebar",
  purpose: "Drives the session sidebar's composition.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you"],
  startedAtIso: "2026-01-01T09:00:00.000Z",
  beats: [],
  replies: [],
};

function sessionStore(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: ["participant-you"] });
  return store;
}

function memoryStore(): UiStateStore {
  return new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
}

interface HarnessProps {
  readonly uiStateStore: UiStateStore;
  readonly registry: SidebarSectionRegistry;
  readonly commandSeat: MountedSidebarSeat;
  readonly bridge: ConsoleBridge;
}

/**
 * The sidebar wired to the real persistence hook, which is how the workspace mounts it.
 *
 * The hook is what restores and saves, so a harness that held the state itself would
 * drive a stand-in for the module under test — the one shape a test may never take.
 */
function MountedSidebar(props: HarnessProps): React.JSX.Element {
  const sidebar = useSidebarLayout({
    uiStateStore: props.uiStateStore,
    sessionId: SESSION_ID,
    onSaveRefused: () => undefined,
  });
  return (
    <SessionSidebar
      sessionStore={sessionStore()}
      bridge={props.bridge}
      openPane={() => undefined}
      layout={sidebar.layout}
      snapshot={sidebar.snapshot}
      registry={props.registry}
      commandSeat={props.commandSeat}
    />
  );
}

interface RenderedSidebar {
  readonly container: HTMLElement;
  readonly uiStateStore: UiStateStore;
  readonly registry: SidebarSectionRegistry;
  readonly commandSeat: MountedSidebarSeat;
  readonly unmount: () => void;
  readonly remount: () => void;
}

function renderSidebar(
  uiStateStore: UiStateStore = memoryStore(),
  registry: SidebarSectionRegistry = new SidebarSectionRegistry(),
): RenderedSidebar {
  const commandSeat = new MountedSidebarSeat();
  const bridge = createFixtureBridge({ scenario: SCENARIO });
  const element = (
    <LiveAnnouncerProvider>
      <MountedSidebar
        uiStateStore={uiStateStore}
        registry={registry}
        commandSeat={commandSeat}
        bridge={bridge}
      />
    </LiveAnnouncerProvider>
  );
  const view = render(element);
  return {
    container: view.container,
    uiStateStore,
    registry,
    commandSeat,
    unmount: view.unmount,
    remount: () => {
      view.unmount();
      view.rerender(element);
    },
  };
}

function headers(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("[data-sidebar-section]")];
}

function headerFor(container: HTMLElement, sectionId: SidebarSectionId): HTMLButtonElement {
  const header = headers(container).find(
    (candidate) => candidate.getAttribute("data-sidebar-section") === sectionId,
  );
  expect(header).not.toBeUndefined();
  return header as HTMLButtonElement;
}

function press(header: HTMLButtonElement): void {
  act(() => {
    header.click();
  });
}

function openSectionIds(container: HTMLElement): string[] {
  return headers(container)
    .filter((header) => header.getAttribute("aria-expanded") === "true")
    .map((header) => header.getAttribute("data-sidebar-section") ?? "");
}

/** Settle the restore, which is the first render every case below depends on. */
async function settled(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(headers(container)).toHaveLength(SIDEBAR_SECTION_IDS.length);
  });
}

describe("the sidebar — which sections it renders", () => {
  it("renders every declared section, in the tuple's order", async () => {
    const rendered = renderSidebar();
    await settled(rendered.container);
    expect(headers(rendered.container).map((header) => header.textContent)).toStrictEqual(
      SIDEBAR_SECTION_IDS.map((sectionId) => SIDEBAR_SECTION_LABELS[sectionId]),
    );
  });

  it("renders a registered body when its section is open", async () => {
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "runs",
      owner: "sidebar-test",
      render: () => <p data-section-body="runs">runs body</p>,
    });
    const rendered = renderSidebar(memoryStore(), registry);
    await settled(rendered.container);

    press(headerFor(rendered.container, "runs"));

    expect(rendered.container.querySelector("[data-section-body='runs']")).not.toBeNull();
  });

  it("renders `not-checked` for a section nobody has filled, and names no owner", async () => {
    // Rule 8's fourth absence: no question was put. `empty` would say a read came back
    // with none, which is a different claim and one this build cannot make.
    const rendered = renderSidebar();
    await settled(rendered.container);

    press(headerFor(rendered.container, "artifacts"));

    const body = rendered.container.querySelector(".meridian-sidebar__body");
    expect(body?.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(body?.textContent).toContain("Nothing has filled this section yet.");
  });

  it("negative control: a body registered under one id does not render under another", async () => {
    // Without this, every case above would pass over a sidebar that rendered whichever
    // body it found first into whichever section happened to be open.
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "runs",
      owner: "sidebar-test",
      render: () => <p data-section-body="runs">runs body</p>,
    });
    const rendered = renderSidebar(memoryStore(), registry);
    await settled(rendered.container);

    press(headerFor(rendered.container, "agents"));

    expect(rendered.container.querySelector("[data-section-body='runs']")).toBeNull();
    expect(rendered.container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });
});

describe("the sidebar — one section open at a time", () => {
  it("opens nothing until something is pressed or something calls", async () => {
    const rendered = renderSidebar();
    await settled(rendered.container);
    expect(openSectionIds(rendered.container)).toStrictEqual([]);
  });

  it("collapses the first when a second is opened", async () => {
    const rendered = renderSidebar();
    await settled(rendered.container);

    press(headerFor(rendered.container, "channels"));
    expect(openSectionIds(rendered.container)).toStrictEqual(["channels"]);

    press(headerFor(rendered.container, "members"));
    expect(openSectionIds(rendered.container)).toStrictEqual(["members"]);
  });

  it("keeps the choice across a remount, from the record it saved", async () => {
    const store = memoryStore();
    const first = renderSidebar(store);
    await settled(first.container);
    press(headerFor(first.container, "repos"));
    await waitFor(async () => {
      expect(await store.read(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY)).not.toBeUndefined();
    });
    first.unmount();

    const second = renderSidebar(store);
    await waitFor(() => {
      expect(openSectionIds(second.container)).toStrictEqual(["repos"]);
    });
  });

  it("negative control: a sidebar with no saved record opens with everything collapsed", async () => {
    // Without this the case above would pass over a sidebar that opened `repos` for
    // every session because the section list happened to start there.
    const second = renderSidebar();
    await settled(second.container);
    expect(openSectionIds(second.container)).toStrictEqual([]);
  });
});

describe("the sidebar — a section that is calling for somebody", () => {
  function registryReporting(
    attentionBySectionId: Partial<Record<SidebarSectionId, "attention" | "failure">>,
  ): SidebarSectionRegistry {
    const registry = new SidebarSectionRegistry();
    for (const [sectionId, tone] of Object.entries(attentionBySectionId)) {
      registry.register({
        id: sectionId as SidebarSectionId,
        owner: "sidebar-test",
        render: () => <p data-section-body={sectionId}>{sectionId} body</p>,
        attention: () => tone,
      });
    }
    return registry;
  }

  it("opens the section reporting attention", async () => {
    const rendered = renderSidebar(memoryStore(), registryReporting({ approvals: "attention" }));
    await settled(rendered.container);
    expect(openSectionIds(rendered.container)).toStrictEqual(["approvals"]);
    expect(headerFor(rendered.container, "approvals").getAttribute("data-attention")).toBe(
      "attention",
    );
  });

  it("leaves exactly one open when two are calling, by declared order", async () => {
    const rendered = renderSidebar(
      memoryStore(),
      registryReporting({ artifacts: "attention", runs: "failure" }),
    );
    await settled(rendered.container);
    expect(openSectionIds(rendered.container)).toStrictEqual(["runs"]);
  });

  it("negative control: a registry reporting nothing leaves the person's choice alone", async () => {
    // Without this the two cases above would pass over a sidebar that opened the first
    // registered section whether or not anything was calling.
    const rendered = renderSidebar(memoryStore(), registryReporting({}));
    await settled(rendered.container);
    expect(openSectionIds(rendered.container)).toStrictEqual([]);
  });
});

describe("the sidebar — collapse, width, and what is kept", () => {
  it("restores collapsed, at the width it was saved with", async () => {
    const store = memoryStore();
    const written = await store.write(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY, "layout", {
      [SIDEBAR_SNAPSHOT_HEADER_KEY]: {
        version: SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
        widthPercent: 31,
        isCollapsed: true,
      },
    });
    expect(written.outcome).toBe("written");

    const rendered = renderSidebar(store);
    await waitFor(() => {
      expect(rendered.container.querySelector(".meridian-sidebar--collapsed")).not.toBeNull();
    });
    // The width travels with the collapse rather than being forgotten by it: expanding
    // puts the sidebar back where the person left it.
    const record = await store.read(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY);
    const header = (record?.value as Record<string, Record<string, unknown>>)[
      SIDEBAR_SNAPSHOT_HEADER_KEY
    ];
    expect(header?.["widthPercent"]).toBe(31);
  });

  it("collapses from the column's own control, so the palette is not the only way", async () => {
    const rendered = renderSidebar();
    await settled(rendered.container);

    act(() => {
      rendered.container.querySelector<HTMLButtonElement>(".meridian-sidebar__collapse")?.click();
    });

    expect(rendered.container.querySelector(".meridian-sidebar--collapsed")).not.toBeNull();
    expect(headers(rendered.container)).toHaveLength(0);
  });

  it("expands again from the collapsed rail, which is what keeps it reachable", async () => {
    const store = memoryStore();
    await store.write(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY, "layout", {
      [SIDEBAR_SNAPSHOT_HEADER_KEY]: {
        version: SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
        widthPercent: 31,
        isCollapsed: true,
      },
    });
    const rendered = renderSidebar(store);
    await waitFor(() => {
      expect(rendered.container.querySelector(".meridian-sidebar__expand")).not.toBeNull();
    });

    act(() => {
      rendered.container.querySelector<HTMLButtonElement>(".meridian-sidebar__expand")?.click();
    });

    expect(headers(rendered.container)).toHaveLength(SIDEBAR_SECTION_IDS.length);
  });

  it("keeps everything under the `layout` class, adding none of its own", async () => {
    // The negative control that catches a widening: the closed enumeration is asserted
    // BY NAME, so a sidebar that had reached for a class of its own fails here rather
    // than at the chokepoint one release later.
    expect([...PERSISTED_VALUE_CLASSES]).toStrictEqual([
      "layout",
      "scroll-position",
      "selection",
      "pin",
      "expansion",
      "scheme",
      "keybinding",
    ]);
    const store = memoryStore();
    const rendered = renderSidebar(store);
    await settled(rendered.container);
    press(headerFor(rendered.container, "goal"));
    await waitFor(async () => {
      const record = await store.read(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY);
      expect(record?.valueClass).toBe("layout");
    });
  });

  it("renders a record this build cannot read as a refusal rather than crashing", async () => {
    const store = memoryStore();
    await store.write(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY, "layout", {
      [SIDEBAR_SNAPSHOT_HEADER_KEY]: { version: 99, widthPercent: 31, isCollapsed: false },
    });
    const rendered = renderSidebar(store);
    await waitFor(() => {
      expect(
        rendered.container.querySelector('.meridian-sidebar__refusals[role="status"]')?.textContent,
      ).toContain("written by a different version");
    });
    expect(headers(rendered.container)).toHaveLength(SIDEBAR_SECTION_IDS.length);
  });

  it("leaves a value the chokepoint will not take to the chokepoint, rather than storing it", async () => {
    // The other half of the same guarantee, and it is deliberately not the sidebar's
    // to enforce: a value carrying authored content is stopped by the store's own
    // validator, which a development build escalates to a tripwire. The sidebar writes
    // identifiers, so it never reaches this — and it holds no second copy of the rule.
    const store = memoryStore();
    await expect(
      store.write(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY, "layout", {
        [SIDEBAR_SNAPSHOT_HEADER_KEY]: { version: 1, openSectionId: "not an identifier at all" },
      }),
    ).rejects.toThrow(/not identifier-shaped/);
  });
});

describe("the sidebar — the keyboard and what it announces", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("puts every section header in tab order with its state exposed", async () => {
    const rendered = renderSidebar();
    await settled(rendered.container);
    for (const header of headers(rendered.container)) {
      expect(header.tagName).toBe("BUTTON");
      expect(header.getAttribute("aria-expanded")).not.toBeNull();
      expect(header.getAttribute("aria-controls")).not.toBeNull();
      expect(header.hasAttribute("disabled")).toBe(false);
    }
  });

  it("focuses the first header and toggles the collapse through the palette's acts", async () => {
    const rendered = renderSidebar();
    await settled(rendered.container);

    act(() => {
      expect(rendered.commandSeat.perform("focusSidebar").status).toBe("performed");
    });
    expect(document.activeElement).toBe(headers(rendered.container)[0]);

    act(() => {
      rendered.commandSeat.perform("toggleSidebarCollapsed");
    });
    expect(rendered.container.querySelector(".meridian-sidebar--collapsed")).not.toBeNull();
  });

  it("announces a section that came back open once, and not again on a later render", async () => {
    const store = memoryStore();
    await store.write(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY, "layout", {
      [SIDEBAR_SNAPSHOT_HEADER_KEY]: {
        version: SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
        widthPercent: 22,
        isCollapsed: false,
        openSectionId: "repos",
      },
    });
    const rendered = renderSidebar(store);
    await waitFor(() => {
      expect(politeText(rendered.container)).toContain(SIDEBAR_SECTION_LABELS["repos"]);
    });
    const announced = politeText(rendered.container);

    press(headerFor(rendered.container, "channels"));

    // The negative control: opening a section re-renders the whole column, and a
    // surface that announced on render would speak again here.
    expect(politeText(rendered.container)).toBe(announced);
  });

  it("says nothing where the settled sidebar reports nothing a person cannot see", async () => {
    // The announcer serialises one polite message at a time, so a sentence nobody
    // needed delays the next one somebody does. A sidebar that restored nothing and
    // opened nothing is a column already on screen.
    const rendered = renderSidebar();
    await settled(rendered.container);
    expect(politeText(rendered.container)).toBe("");
  });
});

function politeText(container: HTMLElement): string {
  return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
}
