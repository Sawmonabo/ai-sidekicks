// The sidebar: every declared section, exactly one of them open, and a section that
// is calling for somebody.
//
// The failure this file exists for is the quiet one. A sidebar that rendered only the
// sections somebody had filled would, on a build where nobody has, be an empty column
// — and an empty column reads as "this session has no work", which is a claim nothing
// established. The second is the open-section rule going one way only: attention that
// never opens a section leaves a red item folded away.
//
// What the arrangement itself does — collapse, width, the keyboard, and what survives
// the window closing — is `SessionSidebar.arrangement.test.tsx`. The harness both
// files mount is `SessionSidebar.test-support.tsx`.

import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionStore } from "../../store/index.js";
import {
  SIDEBAR_SECTION_IDS,
  SidebarSectionRegistry,
  type SidebarSectionId,
} from "../../seats/index.js";
import { SIDEBAR_LAYOUT_RECORD_KEY, SIDEBAR_SECTION_LABELS } from "./sidebar-model.js";
import {
  SESSION_ID,
  headerFor,
  headers,
  memoryStore,
  openSectionIds,
  press,
  renderSidebar,
  sessionStore,
  settled,
} from "./SessionSidebar.test-support.js";

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

  /**
   * A section whose reader answers off the session store itself, as a real family does.
   *
   * The newest event decides: an approval that is waiting is calling for somebody, and
   * one that has been decided is not. Nothing here is held in a test-local variable, so
   * what these cases drive is the projection moving and not a fixture being retyped.
   */
  function registryReadingTheStore(sectionId: SidebarSectionId): SidebarSectionRegistry {
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: sectionId,
      owner: "sidebar-test",
      render: () => <p data-section-body={sectionId}>{sectionId} body</p>,
      attention: ({ sessionStore: store }) => {
        const timeline = store.snapshot().timeline;
        const newest = timeline[timeline.length - 1];
        return newest?.kind === "run.waiting_for_approval" ? "attention" : undefined;
      },
    });
    return registry;
  }

  function applyEvent(store: SessionStore, sequence: number, kind: string): void {
    act(() => {
      store.apply({
        id: `event-${String(sequence)}`,
        sessionId: SESSION_ID,
        sequence,
        kind,
        occurredAt: new Date(Date.UTC(2026, 0, 1, 9, 0, sequence)).toISOString(),
        payload: {},
      });
    });
  }

  it("marks and opens a section for an approval that arrives after mount", async () => {
    // The whole of the defect: the registry and both containers keep one identity for
    // the life of a session, so a sidebar memoized on those alone is computed at mount
    // and never again, and an approval that arrives a second later reaches no marker.
    const store = sessionStore();
    const rendered = renderSidebar(memoryStore(), registryReadingTheStore("approvals"), store);
    await settled(rendered.container);
    expect(openSectionIds(rendered.container)).toStrictEqual([]);

    applyEvent(store, 1, "run.waiting_for_approval");

    expect(headerFor(rendered.container, "approvals").getAttribute("data-attention")).toBe(
      "attention",
    );
    expect(openSectionIds(rendered.container)).toStrictEqual(["approvals"]);
  });

  it("clears the marker when the item resolves", async () => {
    const store = sessionStore();
    const rendered = renderSidebar(memoryStore(), registryReadingTheStore("approvals"), store);
    await settled(rendered.container);
    applyEvent(store, 1, "run.waiting_for_approval");
    expect(headerFor(rendered.container, "approvals").getAttribute("data-attention")).toBe(
      "attention",
    );

    applyEvent(store, 2, "approval.decided");

    expect(headerFor(rendered.container, "approvals").getAttribute("data-attention")).toBeNull();
    expect(openSectionIds(rendered.container)).toStrictEqual([]);
  });

  it("asks each section once per transition, and not again while the projection stands", async () => {
    // The subscription is one number for the whole column, so a store that has not moved
    // costs a pointer comparison and no reader runs. Counted rather than asserted,
    // because a memo that recomputed every pass would still render the right marker.
    const store = sessionStore();
    let readerCallCount = 0;
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "approvals",
      owner: "sidebar-test",
      render: () => <p data-section-body="approvals">approvals body</p>,
      attention: () => {
        readerCallCount += 1;
        return undefined;
      },
    });
    const rendered = renderSidebar(memoryStore(), registry, store);
    await settled(rendered.container);

    const afterMount = readerCallCount;
    applyEvent(store, 1, "run.starting");
    const afterOneTransition = readerCallCount;
    expect(afterOneTransition).toBeGreaterThan(afterMount);

    // A press moves the person's choice and not the projection, so the fold stands.
    press(headerFor(rendered.container, "approvals"));
    expect(readerCallCount).toBe(afterOneTransition);
  });

  it("negative control: a registry reporting nothing leaves the person's choice alone", async () => {
    // Without this the two cases above would pass over a sidebar that opened the first
    // registered section whether or not anything was calling.
    const rendered = renderSidebar(memoryStore(), registryReporting({}));
    await settled(rendered.container);
    expect(openSectionIds(rendered.container)).toStrictEqual([]);
  });
});
