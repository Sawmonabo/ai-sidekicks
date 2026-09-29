// The holder between a chord and a mounted feed.
//
// Two questions decide whether a transcript command acts on the right thing: which
// mount a press reaches when more than one is up, and what happens when none is.
// Both are driven here against the holder itself, with no palette and no window —
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

describe("mounted transcript — which feed an act reaches", () => {
  it("performs on the mounted transcript and says so", () => {
    const fired: string[] = [];
    const mountedTranscript = new MountedTranscript();
    mountedTranscript.adopt(namedActs("pane", fired));
    expect(mountedTranscript.perform("openFind")).toStrictEqual({
      status: "performed",
      act: "openFind",
    });
    expect(fired).toStrictEqual(["pane:openFind"]);
  });

  it("acts on the newest mount while both are up", () => {
    // Two transcript panes in one window are two feeds, and the chord acts on the one
    // that was mounted last rather than on whichever the list happens to start with.
    const fired: string[] = [];
    const mountedTranscript = new MountedTranscript();
    mountedTranscript.adopt(namedActs("first", fired));
    mountedTranscript.adopt(namedActs("second", fired));
    mountedTranscript.perform("jumpToLatest");
    expect(fired).toStrictEqual(["second:jumpToLatest"]);
  });

  it("releases by identity, so an unmount drops its own adoption", () => {
    const fired: string[] = [];
    const mountedTranscript = new MountedTranscript();
    const releaseFirst = mountedTranscript.adopt(namedActs("first", fired));
    mountedTranscript.adopt(namedActs("second", fired));
    releaseFirst();
    expect(mountedTranscript.mountedCount).toBe(1);
    mountedTranscript.perform("foldEveryRun");
    expect(fired).toStrictEqual(["second:foldEveryRun"]);
  });

  it("refuses rather than silently doing nothing when nothing is mounted", () => {
    const mountedTranscript = new MountedTranscript();
    expect(mountedTranscript.perform("openFind")).toStrictEqual({
      status: "refused",
      refusal: TRANSCRIPT_NOT_MOUNTED_REFUSAL,
    });
    expect(TRANSCRIPT_NOT_MOUNTED_REFUSAL.code).toBe("transcript.no_mounted_transcript");
  });

  it("negative control: an act performs on nobody once every mount has gone", () => {
    // Which is what shows the cases above are reading the adoption rather than a
    // set of acts the holder kept a copy of.
    const fired: string[] = [];
    const mountedTranscript = new MountedTranscript();
    const release = mountedTranscript.adopt(namedActs("pane", fired));
    release();
    expect(mountedTranscript.current()).toBeUndefined();
    expect(mountedTranscript.perform("openFind").status).toBe("refused");
    expect(fired).toStrictEqual([]);
  });
});

describe("mounted transcript — a component fills the holder for its lifetime", () => {
  /** A stand-in for the feed: it fills the holder and renders nothing. */
  function TranscriptMountProbe(props: {
    readonly name: string;
    readonly fired: string[];
    readonly mountedTranscript: MountedTranscript;
  }): null {
    useMountedTranscript(namedActs(props.name, props.fired), props.mountedTranscript);
    return null;
  }

  it("fills the holder while mounted and empties it on unmount", () => {
    const fired: string[] = [];
    const mountedTranscript = new MountedTranscript();
    const mounted = render(
      createElement(TranscriptMountProbe, { name: "feed", fired, mountedTranscript }),
    );
    expect(mountedTranscript.mountedCount).toBe(1);
    mountedTranscript.perform("jumpToLatest");
    expect(fired).toStrictEqual(["feed:jumpToLatest"]);
    mounted.unmount();
    expect(mountedTranscript.mountedCount).toBe(0);
  });

  it("acts through the latest render's callbacks rather than the first render's", () => {
    // A feed rebuilds its acts every pass, and a holder keeping the first pass would
    // call into a window's state as it was when the transcript opened.
    const firstPass: string[] = [];
    const laterPass: string[] = [];
    const mountedTranscript = new MountedTranscript();
    const mounted = render(
      createElement(TranscriptMountProbe, { name: "feed", fired: firstPass, mountedTranscript }),
    );
    mounted.rerender(
      createElement(TranscriptMountProbe, { name: "feed", fired: laterPass, mountedTranscript }),
    );
    mountedTranscript.perform("stepFindNext");
    expect(laterPass).toStrictEqual(["feed:stepFindNext"]);
    expect(firstPass).toStrictEqual([]);
  });

  it("negative control: a component that never mounted holds nothing", () => {
    const mountedTranscript = new MountedTranscript();
    expect(mountedTranscript.mountedCount).toBe(0);
    expect(mountedTranscript.current()).toBeUndefined();
  });
});
