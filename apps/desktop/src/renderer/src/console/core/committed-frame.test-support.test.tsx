// The instrument's own claim: it sees a frame the DOM no longer holds.
//
// A recorder that reported the final text once per render would pass every case a
// suite writes with it and prove nothing, because the thing those cases are looking
// for is a frame that has already been replaced by the time anyone can look. So the
// control here is the DOM itself: the same surface, the same interaction, asserted
// after `act` — which is exactly the reading that cannot see the defect.

import { act, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";

import { CommittedFrameRecorder } from "./committed-frame.test-support.js";

/**
 * A surface with the defect the recorder exists for, written out.
 *
 * It holds an answer for the subject it was given and clears it inside an effect, so
 * the commit that renames the subject paints the PREVIOUS subject's answer under the
 * new name. One committed frame long, and gone before `act` returns.
 */
function StaleAnswerSurface(props: { readonly subject: string }): React.JSX.Element {
  const [answer, setAnswer] = useState("one's answer");
  useEffect(() => {
    setAnswer(`${props.subject}'s answer`);
  }, [props.subject]);
  return <output>{`${props.subject}: ${answer}`}</output>;
}

describe("the committed-frame recorder", () => {
  it("records one entry per committed frame, in commit order", () => {
    const frames: string[] = [];
    const view = render(
      <CommittedFrameRecorder
        id="committed-frame-recorder-suite"
        onFrame={(committedText) => frames.push(committedText)}
      >
        <StaleAnswerSurface subject="one" />
      </CommittedFrameRecorder>,
    );
    expect(frames).toStrictEqual(["one: one's answer"]);

    act(() => {
      view.rerender(
        <CommittedFrameRecorder
          id="committed-frame-recorder-suite"
          onFrame={(committedText) => frames.push(committedText)}
        >
          <StaleAnswerSurface subject="two" />
        </CommittedFrameRecorder>,
      );
    });

    // The stale frame is the middle entry, and it is the whole point: the subject was
    // renamed one commit before the effect that cleared the answer under it.
    expect(frames).toStrictEqual(["one: one's answer", "two: one's answer", "two: two's answer"]);
  });

  it("negative control: the reading that cannot see the stale frame", () => {
    // The DOM after `act`, which is what a case would assert on without this
    // instrument. It holds the settled text alone, so the frame above is invisible to
    // it — and a recorder that merely echoed the final render would be indistinguishable
    // from this.
    const view = render(<StaleAnswerSurface subject="one" />);
    act(() => {
      view.rerender(<StaleAnswerSurface subject="two" />);
    });
    expect(document.body.textContent).toBe("two: two's answer");
    expect(document.body.textContent).not.toContain("two: one's answer");
  });
});
