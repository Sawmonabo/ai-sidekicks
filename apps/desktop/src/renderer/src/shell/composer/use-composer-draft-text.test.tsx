// The one reading of the composer's line, and the two ways its callers take it.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DraftStore } from "../../console/persistence/index.js";
import { useComposerDraftText } from "./use-composer-draft-text.js";

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
  it("renders the key's text and re-renders on a write to it", () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    let latest = { text: "", read: (): string => "" };
    const probe = render(
      <Probe
        draftStore={draftStore}
        draftKey={KEY}
        report={(reading) => {
          latest = reading;
        }}
      />,
    );

    expect(probe.container.textContent).toBe("");

    act(() => {
      draftStore.write(KEY, "half a thought");
    });

    expect(probe.container.textContent).toBe("half a thought");
    expect(latest.text).toBe("half a thought");
  });

  it("reads at call time, so a handler is never answering with a stale render's text", () => {
    // Why the reader comes back beside the value: the popover's dismissal records the
    // text it was dismissed AT, and a handler closing over the rendered value would
    // key that dismissal to a string the person has already typed past.
    const draftStore = new DraftStore({ restartNoticePending: false });
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

    // Written WITHOUT a re-render, which is the interval a handler runs in.
    draftStore.write(KEY, "typed since");

    expect(readerFromFirstRender()).toBe("typed since");
  });

  it("ignores a write to another address, so one line never reports another's", () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const probe = render(<Probe draftStore={draftStore} draftKey={KEY} report={() => undefined} />);

    act(() => {
      draftStore.write("session::other", "for somewhere else");
    });

    expect(probe.container.textContent).toBe("");
  });
});
