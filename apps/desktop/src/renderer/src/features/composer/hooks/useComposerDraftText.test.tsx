// The line's reader answers at call time: Send reads the body through it, so the text sent is
// what the line holds, not what a render captured.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence/caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { useComposerDraftText } from "./useComposerDraftText.js";

const KEY = "session::0a1b2c3d";

/** Reports both halves of the reading out of the tree. */
function Probe(props: {
  readonly draftStore: DraftStore;
  readonly draftKey: string;
  readonly report: (reading: { text: string; read: () => string }) => void;
}): React.JSX.Element {
  const reading = useComposerDraftText(props.draftStore, props.draftKey);
  props.report(reading);
  return <p>{reading.text}</p>;
}

describe("useComposerDraftText — one subscription, two ways to take it", () => {
  it("reads at call time, so a handler is never answering with a stale render's text", () => {
    // The popover's dismissal records the text it was dismissed at; a handler closing over the
    // rendered value would key it to a string the person has typed past.
    const draftStore = new DraftStore({
      maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
    });
    let latest = { text: "", read: (): string => "" };
    render(
      <Probe
        draftStore={draftStore}
        draftKey={KEY}
        report={(reading) => {
          latest = reading;
        }}
      />,
    );
    const readerFromFirstRender = latest.read;

    // Written without a re-render, which is the interval a handler runs in.
    draftStore.write(KEY, "typed since");

    expect(readerFromFirstRender()).toBe("typed since");
  });
});
