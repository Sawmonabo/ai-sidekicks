// Directive history, and the boundary it does not cross.
//
// Split along the seam the module was. History is keyed by the address it was typed
// at, so recalling at one target can never surface what was written for another —
// which is a property of the key rather than of the recall, and is what these cases
// hold.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { bridgeAnswering } from "../../../console/bridge/fixture-bridge.test-support.js";
import {
  FIRST_AGENT_ID,
  SECOND_AGENT_ID,
  answerSteer,
  mountAddressable,
} from "./composer-send-bar.test-support.js";
import { DraftStore } from "../../../console/persistence/index.js";
import { AddressedDirectiveHistories } from "./directive-line.js";
import { useDirectiveRecall } from "./use-directive-recall.js";

// The implementations are preserved — this counts constructions and changes nothing
// about what they do, which is what lets the two behavioural cases below share the
// file with the allocation one.
vi.mock(import("./directive-line.js"), { spy: true });

describe("ComposerSendBar — directive history does not cross an addressing boundary", () => {
  /** Put the caret at the start edge, which is the one place ArrowUp recalls. */
  function pressArrowUpAtStart(line: HTMLTextAreaElement): void {
    line.setSelectionRange(0, 0);
    fireEvent.keyDown(line, { key: "ArrowUp" });
  }

  it("recalls nothing under an address the message was not sent from", async () => {
    // The defect: one history for the life of the mounted bar meant ArrowUp under the
    // second agent copied participant-authored text sent to the first into its line.
    const bar = mountAddressable(bridgeAnswering(answerSteer).bridge);
    fireEvent.change(bar.line(), { target: { value: "written for Ada" } });
    await act(async () => {
      fireEvent.keyDown(bar.line(), { key: "Enter" });
    });

    bar.address(SECOND_AGENT_ID);
    fireEvent.change(bar.line(), { target: { value: "  half a thought for Grace" } });
    act(() => {
      pressArrowUpAtStart(bar.line());
    });

    expect(bar.line().value).toBe("  half a thought for Grace");
  });

  it("recalls that address's own message on returning to it", async () => {
    // The negative control for the case above: history is KEYED rather than reset, so
    // coming back finds what was sent from here — a reset would pass the first case
    // and lose the history a person expects to still be there.
    const bar = mountAddressable(bridgeAnswering(answerSteer).bridge);
    fireEvent.change(bar.line(), { target: { value: "written for Ada" } });
    await act(async () => {
      fireEvent.keyDown(bar.line(), { key: "Enter" });
    });

    bar.address(SECOND_AGENT_ID);
    bar.address(FIRST_AGENT_ID);
    act(() => {
      pressArrowUpAtStart(bar.line());
    });

    expect(bar.line().value).toBe("written for Ada");
  });
});

describe("useDirectiveRecall — the histories map is built once per mount", () => {
  function Probe(props: { readonly draftStore: DraftStore }): React.JSX.Element {
    const draftStore = props.draftStore;
    useDirectiveRecall(
      draftStore,
      "channel::main",
      () => draftStore.read("channel::main")?.text ?? "",
    );
    return <p>held</p>;
  }

  it("does not build a new one on every render", () => {
    // `useRef(new AddressedDirectiveHistories())` evaluates its argument on EVERY
    // render and discards all but the first — an allocation per keystroke in the
    // composer's own hot path, invisible to every behavioural case because the ref
    // keeps the first instance and the rest are garbage the moment they are made.
    const built = vi.mocked(AddressedDirectiveHistories);
    built.mockClear();
    const draftStore = new DraftStore({ restartNoticePending: false });
    const probe = render(<Probe draftStore={draftStore} />);
    const afterFirstRender = built.mock.calls.length;

    probe.rerender(<Probe draftStore={draftStore} />);
    probe.rerender(<Probe draftStore={draftStore} />);

    // The negative control: unheld, this is one construction per render — three.
    expect(built.mock.calls.length).toBe(afterFirstRender);
    expect(afterFirstRender).toBe(1);
  });
});
