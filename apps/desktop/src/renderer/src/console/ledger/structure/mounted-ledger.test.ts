// The seat between a chord and a mounted feed.
//
// Two questions decide whether a ledger command acts on the right thing: which
// mount a press reaches when more than one is up, and what happens when none is.
// Both are driven here against the seat itself, with no palette and no window —
// the command side is `structure-commands.test.ts`'s.

import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import {
  LEDGER_NOT_MOUNTED_REFUSAL,
  MountedLedgerSeat,
  useMountedLedger,
  type LedgerStructureActs,
} from "./mounted-ledger.js";

/** An act set that records which of its members ran, tagged with the mount's name. */
function namedActs(name: string, fired: string[]): LedgerStructureActs {
  return {
    openFind: () => fired.push(`${name}:openFind`),
    stepFindNext: () => fired.push(`${name}:stepFindNext`),
    stepFindPrevious: () => fired.push(`${name}:stepFindPrevious`),
    clearFilters: () => fired.push(`${name}:clearFilters`),
    scrollToTail: () => fired.push(`${name}:scrollToTail`),
    collapseAllTerminalChapters: () => fired.push(`${name}:collapseAllTerminalChapters`),
    toggleReplay: () => fired.push(`${name}:toggleReplay`),
    jumpToNextSeam: () => fired.push(`${name}:jumpToNextSeam`),
  };
}

describe("mounted ledger — which feed an act reaches", () => {
  it("performs on the mounted ledger and says so", () => {
    const fired: string[] = [];
    const seat = new MountedLedgerSeat();
    seat.adopt(namedActs("pane", fired));
    expect(seat.perform("openFind")).toStrictEqual({ status: "performed", act: "openFind" });
    expect(fired).toStrictEqual(["pane:openFind"]);
  });

  it("acts on the newest mount while both are up", () => {
    // Two timeline panes in one window are two feeds, and the chord acts on the one
    // that was mounted last rather than on whichever the list happens to start with.
    const fired: string[] = [];
    const seat = new MountedLedgerSeat();
    seat.adopt(namedActs("first", fired));
    seat.adopt(namedActs("second", fired));
    seat.perform("scrollToTail");
    expect(fired).toStrictEqual(["second:scrollToTail"]);
  });

  it("releases by identity, so an unmount drops its own adoption", () => {
    const fired: string[] = [];
    const seat = new MountedLedgerSeat();
    const releaseFirst = seat.adopt(namedActs("first", fired));
    seat.adopt(namedActs("second", fired));
    releaseFirst();
    expect(seat.mountedCount).toBe(1);
    seat.perform("toggleReplay");
    expect(fired).toStrictEqual(["second:toggleReplay"]);
  });

  it("refuses rather than silently doing nothing when nothing is mounted", () => {
    const seat = new MountedLedgerSeat();
    expect(seat.perform("openFind")).toStrictEqual({
      status: "refused",
      refusal: LEDGER_NOT_MOUNTED_REFUSAL,
    });
    expect(LEDGER_NOT_MOUNTED_REFUSAL.code).toBe("ledger.no_mounted_ledger");
  });

  it("negative control: an act performs on nobody once every mount has gone", () => {
    // Which is what shows the cases above are reading the adoption rather than a
    // set of acts the seat kept a copy of.
    const fired: string[] = [];
    const seat = new MountedLedgerSeat();
    const release = seat.adopt(namedActs("pane", fired));
    release();
    expect(seat.current()).toBeUndefined();
    expect(seat.perform("openFind").status).toBe("refused");
    expect(fired).toStrictEqual([]);
  });
});

describe("mounted ledger — a component holds the seat for its lifetime", () => {
  /** A stand-in for the feed: it holds the seat and renders nothing. */
  function LedgerMountProbe(props: {
    readonly name: string;
    readonly fired: string[];
    readonly seat: MountedLedgerSeat;
  }): null {
    useMountedLedger(namedActs(props.name, props.fired), props.seat);
    return null;
  }

  it("takes the seat while mounted and gives it back on unmount", () => {
    const fired: string[] = [];
    const seat = new MountedLedgerSeat();
    const mounted = render(createElement(LedgerMountProbe, { name: "feed", fired, seat }));
    expect(seat.mountedCount).toBe(1);
    seat.perform("clearFilters");
    expect(fired).toStrictEqual(["feed:clearFilters"]);
    mounted.unmount();
    expect(seat.mountedCount).toBe(0);
  });

  it("acts through the latest render's callbacks rather than the first render's", () => {
    // A feed rebuilds its acts every pass, and a seat holding the first pass would
    // call into a window's state as it was when the ledger opened.
    const firstPass: string[] = [];
    const laterPass: string[] = [];
    const seat = new MountedLedgerSeat();
    const mounted = render(
      createElement(LedgerMountProbe, { name: "feed", fired: firstPass, seat }),
    );
    mounted.rerender(createElement(LedgerMountProbe, { name: "feed", fired: laterPass, seat }));
    seat.perform("jumpToNextSeam");
    expect(laterPass).toStrictEqual(["feed:jumpToNextSeam"]);
    expect(firstPass).toStrictEqual([]);
  });

  it("negative control: a component that never mounted holds nothing", () => {
    const seat = new MountedLedgerSeat();
    expect(seat.mountedCount).toBe(0);
    expect(seat.current()).toBeUndefined();
  });
});
