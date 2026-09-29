// The seat between a chord and a mounted feed.
//
// Two questions decide whether a ledger command acts on the right thing: which
// mount a press reaches when more than one is up, and what happens when none is.
// Both are driven here against the seat itself, with no palette and no window —
// the command side is `contributions/commands.test.ts`'.

import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import {
  TRANSCRIPT_NOT_MOUNTED_REFUSAL,
  MountedTranscript,
  type TranscriptActs,
} from "./mounted-transcript.js";
import { useMountedTranscript } from "./hooks/useMountedTranscript.js";

/** An act set that records which of its members ran, tagged with the mount's name. */
function namedActs(name: string, fired: string[]): TranscriptActs {
  return {
    openFind: () => fired.push(`${name}:openFind`),
    stepFindNext: () => fired.push(`${name}:stepFindNext`),
    stepFindPrevious: () => fired.push(`${name}:stepFindPrevious`),
    jumpToLatest: () => fired.push(`${name}:jumpToLatest`),
    foldEveryRun: () => fired.push(`${name}:foldEveryRun`),
  };
}

describe("mounted ledger — which feed an act reaches", () => {
  it("performs on the mounted ledger and says so", () => {
    const fired: string[] = [];
    const seat = new MountedTranscript();
    seat.adopt(namedActs("pane", fired));
    expect(seat.perform("openFind")).toStrictEqual({ status: "performed", act: "openFind" });
    expect(fired).toStrictEqual(["pane:openFind"]);
  });

  it("acts on the newest mount while both are up", () => {
    // Two timeline panes in one window are two feeds, and the chord acts on the one
    // that was mounted last rather than on whichever the list happens to start with.
    const fired: string[] = [];
    const seat = new MountedTranscript();
    seat.adopt(namedActs("first", fired));
    seat.adopt(namedActs("second", fired));
    seat.perform("jumpToLatest");
    expect(fired).toStrictEqual(["second:jumpToLatest"]);
  });

  it("releases by identity, so an unmount drops its own adoption", () => {
    const fired: string[] = [];
    const seat = new MountedTranscript();
    const releaseFirst = seat.adopt(namedActs("first", fired));
    seat.adopt(namedActs("second", fired));
    releaseFirst();
    expect(seat.mountedCount).toBe(1);
    seat.perform("foldEveryRun");
    expect(fired).toStrictEqual(["second:foldEveryRun"]);
  });

  it("refuses rather than silently doing nothing when nothing is mounted", () => {
    const seat = new MountedTranscript();
    expect(seat.perform("openFind")).toStrictEqual({
      status: "refused",
      refusal: TRANSCRIPT_NOT_MOUNTED_REFUSAL,
    });
    expect(TRANSCRIPT_NOT_MOUNTED_REFUSAL.code).toBe("transcript.no_mounted_transcript");
  });

  it("negative control: an act performs on nobody once every mount has gone", () => {
    // Which is what shows the cases above are reading the adoption rather than a
    // set of acts the seat kept a copy of.
    const fired: string[] = [];
    const seat = new MountedTranscript();
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
    readonly seat: MountedTranscript;
  }): null {
    useMountedTranscript(namedActs(props.name, props.fired), props.seat);
    return null;
  }

  it("takes the seat while mounted and gives it back on unmount", () => {
    const fired: string[] = [];
    const seat = new MountedTranscript();
    const mounted = render(createElement(LedgerMountProbe, { name: "feed", fired, seat }));
    expect(seat.mountedCount).toBe(1);
    seat.perform("jumpToLatest");
    expect(fired).toStrictEqual(["feed:jumpToLatest"]);
    mounted.unmount();
    expect(seat.mountedCount).toBe(0);
  });

  it("acts through the latest render's callbacks rather than the first render's", () => {
    // A feed rebuilds its acts every pass, and a seat holding the first pass would
    // call into a window's state as it was when the ledger opened.
    const firstPass: string[] = [];
    const laterPass: string[] = [];
    const seat = new MountedTranscript();
    const mounted = render(
      createElement(LedgerMountProbe, { name: "feed", fired: firstPass, seat }),
    );
    mounted.rerender(createElement(LedgerMountProbe, { name: "feed", fired: laterPass, seat }));
    seat.perform("stepFindNext");
    expect(laterPass).toStrictEqual(["feed:stepFindNext"]);
    expect(firstPass).toStrictEqual([]);
  });

  it("negative control: a component that never mounted holds nothing", () => {
    const seat = new MountedTranscript();
    expect(seat.mountedCount).toBe(0);
    expect(seat.current()).toBeUndefined();
  });
});
