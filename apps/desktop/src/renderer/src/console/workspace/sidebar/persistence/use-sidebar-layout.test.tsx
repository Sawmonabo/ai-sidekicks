// The sidebar arrangement's two lifetimes: the writer bound to a STORE, and the write
// gate bound to a SESSION.
//
// Its own file beside `model/sidebar-model.test.ts`, which drives the state object
// directly. These cases drive the persistence HOOK, because both failures live in how
// the hook holds things across a render rather than in what the object computes, and
// both are silent: one drops every save for the rest of the mount, the other files one
// session's arrangement under another's partition and is corrected on screen a moment
// later while the durable record stays wrong.
//
// The store is real. A hand-rolled stand-in would pass every case below while the
// actual chokepoint refused the value class, which is the one failure a test of a
// persisted setting exists to catch.

import { act, render, waitFor } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { UiStateStore } from "../../../persistence/index.js";
import { GatedPersistenceAdapter } from "../../Workspace.test-support.js";
import { SIDEBAR_DEFAULT_WIDTH_PERCENT } from "../../workspace-bounds.js";
import {
  INITIAL_SIDEBAR_LAYOUT_STATE,
  SIDEBAR_LAYOUT_RECORD_KEY,
  encodeSidebarLayout,
} from "../model/sidebar-layout-record.js";
import { type SidebarModel } from "../model/sidebar-model.js";
import { useSidebarLayout } from "./use-sidebar-layout.js";

const SESSION_A = "session-sidebar-a";
const SESSION_B = "session-sidebar-b";

/** A width nothing else in this file uses, so a record can be traced to its session. */
const WIDTH_ARRANGED_IN_A = SIDEBAR_DEFAULT_WIDTH_PERCENT + 7;

/** And one nothing else uses either, so an adopted width can be traced to B's record. */
const WIDTH_SAVED_IN_B = SIDEBAR_DEFAULT_WIDTH_PERCENT + 11;

/**
 * The real hook, with the model handed back so a case can drive a gesture.
 *
 * A probe rather than the whole sidebar column: what these cases are about is the
 * hook's holding, and mounting the column would add a registry, a session store and a
 * bridge to a claim none of them bear on.
 */
function SidebarPersistenceProbe(props: {
  readonly uiStateStore: UiStateStore;
  readonly sessionId: string;
  readonly onRendered: (model: SidebarModel) => void;
}): ReactElement {
  const sidebar = useSidebarLayout({
    uiStateStore: props.uiStateStore,
    sessionId: props.sessionId,
    onSaveRefused: () => undefined,
  });
  props.onRendered(sidebar.model);
  return <output>{String(sidebar.snapshot.hasSettled)}</output>;
}

/** What every case here holds: the store, and a way to drag the divider. */
interface MountedProbe {
  readonly adapter: GatedPersistenceAdapter;
  readonly uiStateStore: UiStateStore;
  /** Move the divider, which is what a subscribed writer files. */
  dragDividerTo(widthPercent: number): void;
  /** Point the SAME mount at another session, as a navigation does. */
  showSession(sessionId: string): void;
  /** The model the hook is holding, for the controls that read it. */
  model(): SidebarModel;
  settled(): Promise<void>;
}

function mountProbe(options: { readonly underStrictMode: boolean }): MountedProbe {
  const adapter = new GatedPersistenceAdapter();
  const uiStateStore = new UiStateStore({ adapter });
  let latestModel: SidebarModel | undefined;
  const treeAt = (sessionId: string): ReactElement => {
    const probe = (
      <SidebarPersistenceProbe
        uiStateStore={uiStateStore}
        sessionId={sessionId}
        onRendered={(model) => {
          latestModel = model;
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
        latestModel?.recordWidthPercent(widthPercent);
      });
    },
    showSession: (sessionId) => {
      act(() => {
        view.rerender(treeAt(sessionId));
      });
    },
    model: () => {
      if (latestModel === undefined) {
        throw new Error("the probe rendered no sidebar model");
      }
      return latestModel;
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
    await crossMacrotaskBoundary();

    await waitFor(async () => {
      const record = await probe.uiStateStore.read(SESSION_A, SIDEBAR_LAYOUT_RECORD_KEY);
      expect(record).not.toBeUndefined();
    });
  });

  it("negative control: the same drag lands under an ordinary single mount too", async () => {
    // Without this the case above would pass over a probe whose drag wrote on some path
    // other than the writer being tested.
    const probe = mountProbe({ underStrictMode: false });
    await probe.settled();

    probe.dragDividerTo(WIDTH_ARRANGED_IN_A);
    await crossMacrotaskBoundary();

    await waitFor(() => {
      expect(probe.adapter.asked.map((write) => write.partition)).toContain(SESSION_A);
    });
  });

  it("writes under the one value class the chokepoint admits for a layout", async () => {
    const probe = mountProbe({ underStrictMode: false });
    await probe.settled();

    probe.dragDividerTo(WIDTH_ARRANGED_IN_A);
    await crossMacrotaskBoundary();

    await waitFor(async () => {
      const record = await probe.uiStateStore.read(SESSION_A, SIDEBAR_LAYOUT_RECORD_KEY);
      expect(record?.valueClass).toBe("layout");
    });
  });
});

describe("the sidebar's persistence — the write gate across a navigation", () => {
  it("writes nothing under the arriving session while that session's read is in flight", async () => {
    // A gate that stayed open across a navigation between two open sessions filed the
    // previous session's width under the arriving session's partition and clobbered the
    // record being read. The screen converges a moment later; the durable record does
    // not.
    const probe = mountProbe({ underStrictMode: false });
    await probe.settled();

    probe.adapter.holdReads();
    probe.showSession(SESSION_B);
    probe.dragDividerTo(WIDTH_ARRANGED_IN_A);
    await crossMacrotaskBoundary();

    expect(probe.adapter.asked.map((write) => write.partition)).not.toContain(SESSION_B);
  });

  it("negative control: the arriving session really does start unsettled", async () => {
    // The gate is the model's own settlement, and the model is re-minted with the
    // session — so this asserts the premise the case above rests on directly. Without
    // it that case could pass over a navigation that never reached the arriving
    // session at all.
    const probe = mountProbe({ underStrictMode: false });
    await probe.settled();

    probe.adapter.holdReads();
    probe.showSession(SESSION_B);
    await crossMacrotaskBoundary();

    expect(probe.model().snapshot.hasSettled).toBe(false);
  });

  it("saves under the arriving session once its own record has landed", async () => {
    // Which is what makes the case above a GATE rather than a sidebar that stopped
    // saving after a navigation.
    const probe = mountProbe({ underStrictMode: false });
    await probe.settled();

    probe.showSession(SESSION_B);
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();
    probe.dragDividerTo(WIDTH_ARRANGED_IN_A);
    await crossMacrotaskBoundary();

    await waitFor(() => {
      expect(probe.adapter.asked.map((write) => write.partition)).toContain(SESSION_B);
    });
  });

  it("keeps an act made while the arriving session's record was in flight", async () => {
    // The write gate holds the person's act out of the store until the read lands, and
    // a restore that then replaced the width and the collapse wholesale would undo the
    // act a moment later, under the person's hands and with nothing on screen to say
    // why.
    const probe = mountProbe({ underStrictMode: false });
    await probe.settled();
    await probe.uiStateStore.write(
      SESSION_B,
      SIDEBAR_LAYOUT_RECORD_KEY,
      "layout",
      encodeSidebarLayout({
        ...INITIAL_SIDEBAR_LAYOUT_STATE,
        widthPercent: WIDTH_SAVED_IN_B,
        isCollapsed: false,
      }),
    );

    probe.adapter.holdReads();
    probe.showSession(SESSION_B);
    act(() => {
      probe.model().setColumnCollapsed(true);
    });
    probe.adapter.releaseReads();
    await crossMacrotaskBoundary();

    // Theirs on the axis they touched, the record's on the one they did not.
    expect(probe.model().snapshot.state.isCollapsed).toBe(true);
    expect(probe.model().snapshot.state.widthPercent).toBe(WIDTH_SAVED_IN_B);
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
        ...INITIAL_SIDEBAR_LAYOUT_STATE,
        widthPercent: WIDTH_SAVED_IN_B,
        isCollapsed: true,
      }),
    );

    probe.showSession(SESSION_B);
    await crossMacrotaskBoundary();

    expect(probe.model().snapshot.state.widthPercent).toBe(WIDTH_SAVED_IN_B);
    expect(probe.model().snapshot.state.isCollapsed).toBe(true);
  });

  it("negative control: an untouched arrival adopts the record and writes nothing back", async () => {
    // A gate that settled ABOVE the restore fired the restore's own listener with it
    // already open and filed the record straight back — one durable write per session
    // opened, and where the decode had narrowed an axis the narrowed value replaced
    // what the record held.
    const probe = mountProbe({ underStrictMode: false });
    await probe.settled();
    await probe.uiStateStore.write(
      SESSION_B,
      SIDEBAR_LAYOUT_RECORD_KEY,
      "layout",
      encodeSidebarLayout({
        ...INITIAL_SIDEBAR_LAYOUT_STATE,
        widthPercent: WIDTH_SAVED_IN_B,
        isCollapsed: true,
      }),
    );

    // Counted from HERE, because seeding the record above is itself a write through
    // this adapter and a bare `asked` would report the fixture as the hook's own.
    const writesBeforeArrival = probe.adapter.asked.length;

    probe.showSession(SESSION_B);
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();

    expect(probe.model().snapshot.state.widthPercent).toBe(WIDTH_SAVED_IN_B);
    expect(
      probe.adapter.asked.slice(writesBeforeArrival).map((write) => write.partition),
    ).not.toContain(SESSION_B);
  });

  it("files the act a person made while the record was in flight", async () => {
    // Which is what makes the control above a GATE rather than a sidebar that stopped
    // saving on arrival: the person's collapse is theirs, it differs from the record,
    // and it reaches the store once the read has landed.
    const probe = mountProbe({ underStrictMode: false });
    await probe.settled();
    await probe.uiStateStore.write(
      SESSION_B,
      SIDEBAR_LAYOUT_RECORD_KEY,
      "layout",
      encodeSidebarLayout({
        ...INITIAL_SIDEBAR_LAYOUT_STATE,
        widthPercent: WIDTH_SAVED_IN_B,
        isCollapsed: false,
      }),
    );

    const writesBeforeArrival = probe.adapter.asked.length;

    probe.adapter.holdReads();
    probe.showSession(SESSION_B);
    act(() => {
      probe.model().setColumnCollapsed(true);
    });
    probe.adapter.releaseReads();
    await crossMacrotaskBoundary();

    await waitFor(() => {
      expect(
        probe.adapter.asked.slice(writesBeforeArrival).map((write) => write.partition),
      ).toContain(SESSION_B);
    });
  });
});
