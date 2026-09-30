// The instrument's own claim: it sees a frame the DOM no longer holds. A recorder that reported
// the final text once per render would pass every case written with it and prove nothing, since
// the frames those cases look for are replaced by the time anyone can look. The control is the
// DOM itself, asserted after `act`, which cannot see the defect.

import { act, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";

import { CommittedFrameRecorder } from "./CommittedFrameRecorder.js";

/**
 * A component with the defect the recorder exists for, written out.
 *
 * It holds an answer for the subject it was given and clears it inside an effect, so the commit
 * that renames the subject paints the previous subject's answer under the new name: one
 * committed frame long, gone before `act` returns.
 */
function StaleAnswerReadout(props: { readonly subject: string }): React.JSX.Element {
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
        <StaleAnswerReadout subject="one" />
      </CommittedFrameRecorder>,
    );
    expect(frames).toStrictEqual(["one: one's answer"]);

    act(() => {
      view.rerender(
        <CommittedFrameRecorder
          id="committed-frame-recorder-suite"
          onFrame={(committedText) => frames.push(committedText)}
        >
          <StaleAnswerReadout subject="two" />
        </CommittedFrameRecorder>,
      );
    });

    // The stale frame is the middle entry: the subject was renamed one commit before the effect
    // that cleared the answer under it.
    expect(frames).toStrictEqual(["one: one's answer", "two: one's answer", "two: two's answer"]);
  });

  it("negative control: the reading that cannot see the stale frame", () => {
    // The DOM after `act`, which is what a case would assert on without this instrument. It
    // holds the settled text alone, so the stale frame is invisible to it, and a recorder that
    // echoed the final render would be indistinguishable.
    const view = render(<StaleAnswerReadout subject="one" />);
    act(() => {
      view.rerender(<StaleAnswerReadout subject="two" />);
    });
    expect(document.body.textContent).toBe("two: two's answer");
    expect(document.body.textContent).not.toContain("two: one's answer");
  });
});
