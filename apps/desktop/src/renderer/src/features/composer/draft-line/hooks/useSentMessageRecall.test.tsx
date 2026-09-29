// The directive history hook builds its per-address map once per mount. Keeping each
// address's sent messages apart is held by the history cases in `sent-message-history.test.ts`.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/console/core/constants/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { AddressedDirectiveHistories } from "../sent-message-history.js";
import { composerDraftKey } from "../draft-key.js";
import { CHANNEL_TARGET } from "../send-router.test-support.js";
import { useDirectiveRecall } from "./useSentMessageRecall.js";

// The implementation is preserved — this counts constructions and changes nothing about
// what it does.
vi.mock(import("../sent-message-history.js"), { spy: true });

describe("useDirectiveRecall — the histories map is built once per mount", () => {
  function Probe(props: { readonly draftStore: DraftStore }): React.JSX.Element {
    const draftStore = props.draftStore;
    const draftKey = composerDraftKey(CHANNEL_TARGET);
    useDirectiveRecall(draftStore, draftKey, () => draftStore.read(draftKey)?.text ?? "");
    return <p>held</p>;
  }

  it("does not build a new one on every render", () => {
    // `useRef(new AddressedDirectiveHistories())` evaluates its argument on EVERY
    // render and discards all but the first — an allocation per keystroke in the
    // composer's own hot path, invisible to every behavioural case because the ref
    // keeps the first instance and the rest are garbage the moment they are made.
    const built = vi.mocked(AddressedDirectiveHistories);
    built.mockClear();
    const draftStore = new DraftStore({
      maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
    });
    const probe = render(<Probe draftStore={draftStore} />);
    const afterFirstRender = built.mock.calls.length;

    probe.rerender(<Probe draftStore={draftStore} />);
    probe.rerender(<Probe draftStore={draftStore} />);

    // The negative control: unheld, this is one construction per render — three.
    expect(built.mock.calls.length).toBe(afterFirstRender);
    expect(afterFirstRender).toBe(1);
  });
});
