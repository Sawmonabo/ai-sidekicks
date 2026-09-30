// The hook builds its per-address history map once per mount. Address separation is covered
// by `sent-message-history.test.ts`.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { SentMessageHistories } from "../sent-message-history.js";
import { composerDraftKey } from "../draft-key.js";
import { SESSION_TARGET } from "../send-router.test-support.js";
import { useSentMessageRecall } from "./useSentMessageRecall.js";

// A spy: the implementation is kept and only constructions are counted.
vi.mock(import("../sent-message-history.js"), { spy: true });

describe("useSentMessageRecall — the histories map is built once per mount", () => {
  function Probe(props: { readonly draftStore: DraftStore }): React.JSX.Element {
    const draftStore = props.draftStore;
    const draftKey = composerDraftKey(SESSION_TARGET);
    useSentMessageRecall(draftStore, draftKey, () => draftStore.read(draftKey)?.text ?? "");
    return <p>held</p>;
  }

  it("does not build a new one on every render", () => {
    // `useRef(new SentMessageHistories())` would build one per render, invisible to behavioral
    // cases because the ref keeps the first instance.
    const built = vi.mocked(SentMessageHistories);
    built.mockClear();
    const draftStore = new DraftStore({
      maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
    });
    const probe = render(<Probe draftStore={draftStore} />);
    const afterFirstRender = built.mock.calls.length;

    probe.rerender(<Probe draftStore={draftStore} />);
    probe.rerender(<Probe draftStore={draftStore} />);

    // Unheld, this would be one construction per render: three.
    expect(built.mock.calls.length).toBe(afterFirstRender);
    expect(afterFirstRender).toBe(1);
  });
});
