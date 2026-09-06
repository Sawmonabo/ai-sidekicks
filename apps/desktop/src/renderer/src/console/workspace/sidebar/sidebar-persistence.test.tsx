// The sidebar arrangement's two lifetimes: the writer bound to a STORE, and the write
// gate bound to a SESSION.
//
// Its own file beside `sidebar-state.test.ts`, which drives the state object directly.
// These cases drive the persistence HOOK, because both failures live in how the hook
// holds things across a render rather than in what the object computes, and both are
// silent: one drops every save for the rest of the mount, the other files one
// session's arrangement under another's partition and is corrected on screen a moment
// later while the durable record stays wrong.

import { act, render, waitFor } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { UiStateStore } from "../../persistence/index.js";
import { SIDEBAR_DEFAULT_WIDTH_PERCENT } from "../workspace-bounds.js";
import { GatedPersistenceAdapter, drainMicrotasks } from "../Workspace.test-support.js";
import { SIDEBAR_LAYOUT_RECORD_KEY, encodeSidebarLayout } from "./sidebar-model.js";
import { useSidebarLayout, type SidebarLayout } from "./sidebar-state.js";

const SESSION_A = "session-sidebar-a";
const SESSION_B = "session-sidebar-b";

/** A width nothing else in this file uses, so a record can be traced to its session. */
const WIDTH_ARRANGED_IN_A = SIDEBAR_DEFAULT_WIDTH_PERCENT + 7;

/** And one nothing else uses either, so an adopted width can be traced to B's record. */
const WIDTH_SAVED_IN_B = SIDEBAR_DEFAULT_WIDTH_PERCENT + 11;

/**
 * The real hook, with the layout handed back so a case can drive a gesture.
 *
 * A probe rather than the whole sidebar column: what these cases are about is the
 * hook's holding, and mounting the column would add a registry, a session store and a
 * bridge to a claim none of them bear on.
 */
function SidebarPersistenceProbe(props: {
  readonly uiStateStore: UiStateStore;
  readonly sessionId: string;
  readonly onRendered: (layout: SidebarLayout) => void;
}): ReactElement {
  const sidebar = useSidebarLayout({
    uiStateStore: props.uiStateStore,
    sessionId: props.sessionId,
    onSaveRefused: () => undefined,
  });
  props.onRendered(sidebar.layout);
  return <output>{String(sidebar.snapshot.hasSettled)}</output>;
}

/** What every case here holds: the ledger, the store, and a way to drag the divider. */
interface MountedProbe {
  readonly adapter: GatedPersistenceAdapter;
  readonly uiStateStore: UiStateStore;
  /** Move the divider, which is what a subscribed writer files. */
  dragDividerTo(widthPercent: number): void;
  /** Point the SAME mount at another session, as a navigation does. */
  showSession(sessionId: string): void;
  /** The state object the hook is holding, for the one control that reads it. */
  layout(): SidebarLayout;
  settled(): Promise<void>;
}

function mountProbe(options: { readonly underStrictMode: boolean }): MountedProbe {
  const adapter = new GatedPersistenceAdapter();
  const uiStateStore = new UiStateStore({ adapter });
  let latestLayout: SidebarLayout | undefined;
  const treeAt = (sessionId: string): ReactElement => {
    const probe = (
      <SidebarPersistenceProbe
        uiStateStore={uiStateStore}
        sessionId={sessionId}
        onRendered={(layout) => {
          latestLayout = layout;
        }}
      />
    );
    return options.underStrictMode ? <StrictMode>{probe}</StrictMode> : probe;
  };
  const view = render(treeAt(SESSION_A));
  return {
    adapter,
    uiStateStore,
    dragDividerTo: (widthPercent) => {
      act(() => {
        latestLayout?.recordWidthPercent(widthPercent);
      });
    },
    showSession: (sessionId) => {
      act(() => {
        view.rerender(treeAt(sessionId));
      });
    },
    layout: () => {
      if (latestLayout === undefined) {
        throw new Error("the probe rendered no sidebar layout");
      }
      return latestLayout;
    },
    settled: async () => {
      await waitFor(() => {
        expect(view.container.textContent).toBe("true");
      });
    },
  };
}

describe("the sidebar's persistence — a writer whose terminal is one-way", () => {
  it("keeps saving through a double-mount, which re-commits the value it just closed", async () => {
    // `flushAndClose` retires a writer permanently and `request` then drops every
    // arrangement silently — no refusal raised, nothing on screen — so a holder that
    // re-committed the corpse left a person rearranging all session with nothing kept.
    // React's own double-mount is the trigger, and it arrives with a wrapper nobody
    // re-audits this call site for.
    const probe = mountProbe({ underStrictMode: true });
    await probe.settled();

    probe.dragDividerTo(WIDTH_ARRANGED_IN_A);
    await drainMicrotasks();

    await waitFor(async () => {
      const record = await probe.uiStateStore.read(SESSION_A, SIDEBAR_LAYOUT_RECORD_KEY);
      expect(record).not.toBeUndefined();
    });
  });

  it("negative control: the same drag lands under an ordinary single mount too", async () => {
    // Without this the case above would pass over a probe whose drag wrote on some
    // path other than the writer being tested.
    const probe = mountProbe({ underStrictMode: false });
    await probe.settled();

    probe.dragDividerTo(WIDTH_ARRANGED_IN_A);
    await drainMicrotasks();

    await waitFor(() => {
      expect(probe.adapter.asked.map((write) => write.partition)).toContain(SESSION_A);
    });
  });
});

describe("the sidebar's persistence — the write gate across a navigation", () => {
  it("writes nothing under the arriving session while that session's read is in flight", async () => {
    // `SidebarLayout.hasSettled` is set once by `adopt` on an object held for the
    // MOUNT, so it stayed true across a navigation between two open sessions. In the
    // window where the arriving session's read was still resolving, a divider drag
    // filed the previous session's width under the arriving session's partition and
    // clobbered the record being read. The screen converges a moment later; the
    // durable record does not.
    const probe = mountProbe({ underStrictMode: false });
    await probe.settled();

    probe.adapter.holdReads();
    probe.showSession(SESSION_B);
    probe.dragDividerTo(WIDTH_ARRANGED_IN_A);
    await drainMicrotasks();

    expect(probe.adapter.asked.map((write) => write.partition)).not.toContain(SESSION_B);
  });

  it("saves under the arriving session once its own record has landed", async () => {
    // Which is what makes the case above a GATE rather than a sidebar that stopped
    // saving after a navigation.
    const probe = mountProbe({ underStrictMode: false });
    await probe.settled();

    probe.showSession(SESSION_B);
    await drainMicrotasks();
    await drainMicrotasks();
    probe.dragDividerTo(WIDTH_ARRANGED_IN_A);
    await drainMicrotasks();

    await waitFor(() => {
      expect(probe.adapter.asked.map((write) => write.partition)).toContain(SESSION_B);
    });
  });

  it("keeps an act made while the arriving session's record was in flight", async () => {
    // The write gate holds the person's act out of the store until the read lands, and
    // then `adopt` replaces the width, the collapse and the open section wholesale —
    // so the act survives the gate and is undone by the restore a moment later, under
    // the person's hands and with nothing on screen to say why.
    const probe = mountProbe({ underStrictMode: false });
    await probe.settled();
    await probe.uiStateStore.write(
      SESSION_B,
      SIDEBAR_LAYOUT_RECORD_KEY,
      "layout",
      encodeSidebarLayout({
        widthPercent: WIDTH_SAVED_IN_B,
        isCollapsed: false,
        chosenSectionId: undefined,
      }),
    );

    probe.adapter.holdReads();
    probe.showSession(SESSION_B);
    act(() => {
      probe.layout().setCollapsed(true);
    });
    probe.adapter.releaseReads();
    await drainMicrotasks();

    // Theirs on the axis they touched, the record's on the two they did not.
    expect(probe.layout().snapshot().state.isCollapsed).toBe(true);
    expect(probe.layout().snapshot().state.widthPercent).toBe(WIDTH_SAVED_IN_B);
  });

  it("negative control: an untouched arrival takes the record whole", async () => {
    // Without this the case above would pass over a hook that had simply stopped
    // adopting what it reads.
    const probe = mountProbe({ underStrictMode: false });
    await probe.settled();
    await probe.uiStateStore.write(
      SESSION_B,
      SIDEBAR_LAYOUT_RECORD_KEY,
      "layout",
      encodeSidebarLayout({
        widthPercent: WIDTH_SAVED_IN_B,
        isCollapsed: true,
        chosenSectionId: undefined,
      }),
    );

    probe.showSession(SESSION_B);
    await drainMicrotasks();

    expect(probe.layout().snapshot().state.widthPercent).toBe(WIDTH_SAVED_IN_B);
    expect(probe.layout().snapshot().state.isCollapsed).toBe(true);
  });

  it("negative control: the reading the gate used to consult really does stay open", async () => {
    // The layout's own `hasSettled` is asserted directly, in the exact state the case
    // above exercises. Without it, that case could pass over a navigation that
    // happened to reset the layout object too — and the session-scoped gate would be
    // proving nothing about a hazard that was never there.
    const probe = mountProbe({ underStrictMode: false });
    await probe.settled();

    probe.adapter.holdReads();
    probe.showSession(SESSION_B);
    await drainMicrotasks();

    expect(probe.layout().snapshot().hasSettled).toBe(true);
  });
});
