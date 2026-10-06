// The holder between a chord and a mounted feed: which mount a press reaches when more than one
// is up, and what happens when none is. The command side is `contributions/commands.test.ts`.

import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import {
  TRANSCRIPT_NOT_MOUNTED_REFUSAL,
  MountedTranscript,
  type TranscriptActs,
} from "./mounted-transcript.js";
import { useMountedTranscript } from "./hooks/useMountedTranscript.js";

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
    mountedTranscript.adopt(namedActs("pane", fired), document);
    expect(mountedTranscript.perform("openFind", document)).toStrictEqual({
      status: "performed",
      act: "openFind",
    });
    expect(fired).toStrictEqual(["pane:openFind"]);
  });

  it("acts on the newest mount in the window the act runs in while several are up", () => {
    // Two panes are two feeds, and the chord acts on the one mounted last, not the list's first.
    // A feed in another window, mounted later still, never takes this window's chord.
    const fired: string[] = [];
    const mountedTranscript = new MountedTranscript();
    mountedTranscript.adopt(namedActs("first", fired), document);
    mountedTranscript.adopt(namedActs("second", fired), document);
    mountedTranscript.adopt(
      namedActs("another window", fired),
      document.implementation.createHTMLDocument(),
    );
    mountedTranscript.perform("jumpToLatest", document);
    expect(fired).toStrictEqual(["second:jumpToLatest"]);
  });

  it("releases by identity, so an unmount drops its own adoption", () => {
    const fired: string[] = [];
    const mountedTranscript = new MountedTranscript();
    const releaseFirst = mountedTranscript.adopt(namedActs("first", fired), document);
    mountedTranscript.adopt(namedActs("second", fired), document);
    releaseFirst();
    mountedTranscript.perform("foldEveryRun", document);
    expect(fired).toStrictEqual(["second:foldEveryRun"]);
  });

  it("refuses rather than silently doing nothing when nothing is mounted", () => {
    const mountedTranscript = new MountedTranscript();
    expect(mountedTranscript.perform("openFind", document)).toStrictEqual({
      status: "refused",
      refusal: TRANSCRIPT_NOT_MOUNTED_REFUSAL,
    });
    expect(TRANSCRIPT_NOT_MOUNTED_REFUSAL.code).toBe("transcript.no_mounted_transcript");
  });
});

describe("mounted transcript — a component fills the holder for its lifetime", () => {
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
    mountedTranscript.perform("jumpToLatest", document);
    expect(fired).toStrictEqual(["feed:jumpToLatest"]);
    mounted.unmount();
    expect(mountedTranscript.perform("jumpToLatest", document).status).toBe("refused");
  });

  it("acts through the latest render's callbacks rather than the first render's", () => {
    // A feed rebuilds its acts every pass; a holder keeping the first pass would call into
    // window state as it was when the transcript opened.
    const firstPass: string[] = [];
    const laterPass: string[] = [];
    const mountedTranscript = new MountedTranscript();
    const mounted = render(
      createElement(TranscriptMountProbe, { name: "feed", fired: firstPass, mountedTranscript }),
    );
    mounted.rerender(
      createElement(TranscriptMountProbe, { name: "feed", fired: laterPass, mountedTranscript }),
    );
    mountedTranscript.perform("stepFindNext", document);
    expect(laterPass).toStrictEqual(["feed:stepFindNext"]);
    expect(firstPass).toStrictEqual([]);
  });
});
