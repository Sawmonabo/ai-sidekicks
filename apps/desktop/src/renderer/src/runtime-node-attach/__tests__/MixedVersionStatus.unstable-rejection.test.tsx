// The refused write arrives as `unknown`, and this view reads it exactly once.
//
// `writeAttemptRejection` is a PROP typed `unknown` — whatever a parent caught off
// the control-plane call — so its members are getters as easily as they are data. The
// recognizer used to be a type PREDICATE: it read a snapshot, said yes, and narrowed
// the candidate, after which the render's own `writeAttemptRejection.code` was a
// SECOND access on the same unvalidated value. Two failures follow from that one line,
// and both land inside a render:
//
//   • A member that answers something else the second time renders the floor arm with
//     data the wire never sent — the `data-write-refusal` facet says
//     `version.floor_exceeded` while the sentence beside it says something else.
//   • A member that throws on the second read takes the subtree down. There is no
//     error boundary in the renderer at this tier, and even a future one would swap
//     the crash for a fallback that hides the node — an eject-by-render, from the one
//     component whose whole job is to keep a refused node visible (I-003-1).
//
// Its own file rather than a fifth block in `MixedVersionStatus.test.tsx`, which is
// about the access verdict and the three refusal arms; this one is about how many
// times the prop is read. The fixtures come from `src/shared/wire-errors.test-support.ts`
// — the home the two reader suites already share — because a value that answers a
// scripted number of readings is exactly the role they play there.
//
// Each case carries its NEGATIVE CONTROL as the fixture itself: a candidate that
// answers once and throws afterwards, asserted to do so. Without it, "the arm renders
// the snapshot" would also be satisfied by a fixture that answered the same thing
// every time.

import { render, screen } from "@testing-library/react";

import { VERSION_FLOOR_EXCEEDED_CODE } from "@ai-sidekicks/contracts";

import { everyTrapThrows, readableOnce } from "../../../../shared/wire-errors.test-support.js";
import { MixedVersionStatus } from "../MixedVersionStatus.js";

/** What the server said, on the reading the recognizer is entitled to take. */
const FLOOR_SENTENCE = "client version 1.0 is below the session floor 2.0";

/** What a second reading of the same members would have answered instead. */
const SECOND_READING_CODE = "runtimenode.attach_conflict";
const SECOND_READING_SENTENCE = "a sentence the wire never sent";

/**
 * The typed refusal, readable exactly once per member.
 *
 * One answer each, so every reading after the recognizer's throws — which is what a
 * returned candidate turns into: the guard says yes, and the render is the throw.
 */
function floorRefusalReadableOnce(): unknown {
  return readableOnce({
    code: [VERSION_FLOOR_EXCEEDED_CODE],
    message: [FLOOR_SENTENCE],
  });
}

/** The same refusal, whose members answer something different on a second reading. */
function floorRefusalAnsweringTwice(): unknown {
  return readableOnce({
    code: [VERSION_FLOOR_EXCEEDED_CODE, SECOND_READING_CODE],
    message: [FLOOR_SENTENCE, SECOND_READING_SENTENCE],
  });
}

describe("MixedVersionStatus — an unstable rejection is read once and rendered from the snapshot", () => {
  it("renders the floor arm from a candidate whose second reading throws", () => {
    expect(() => {
      render(
        <MixedVersionStatus
          rosterEntry={null}
          writeAttemptRejection={floorRefusalReadableOnce()}
        />,
      );
    }).not.toThrow();

    const refusalAlert = screen.getByRole("alert", { name: "version-floor-write-refusal" });
    expect(refusalAlert.textContent).toContain(VERSION_FLOOR_EXCEEDED_CODE);
    expect(refusalAlert.textContent).toContain(FLOOR_SENTENCE);
    // The node block still renders beside it: a refusal annotates the node (I-003-1),
    // and a render that threw would have removed both.
    expect(screen.getByLabelText("mixed-version-status")).toBeDefined();
  });

  it("negative control: that candidate really is readable exactly once", () => {
    const candidate = floorRefusalReadableOnce() as { readonly code: string };
    expect(candidate.code).toBe(VERSION_FLOOR_EXCEEDED_CODE);
    expect(() => candidate.code).toThrow();
  });

  it("renders the reading the recognizer took, never a later one", () => {
    // The quieter half of the same defect, and the one no crash reports: the arm was
    // chosen on the first reading and PAINTED from the second, so the facet and the
    // sentence beside it described two different refusals.
    render(
      <MixedVersionStatus
        rosterEntry={null}
        writeAttemptRejection={floorRefusalAnsweringTwice()}
      />,
    );

    const refusalAlert = screen.getByRole("alert", { name: "version-floor-write-refusal" });
    expect(refusalAlert.getAttribute("data-write-refusal")).toBe(VERSION_FLOOR_EXCEEDED_CODE);
    expect(refusalAlert.textContent).toContain(FLOOR_SENTENCE);
    expect(refusalAlert.textContent).not.toContain(SECOND_READING_CODE);
    expect(refusalAlert.textContent).not.toContain(SECOND_READING_SENTENCE);
  });

  it("negative control: that candidate really answers differently the second time", () => {
    const candidate = floorRefusalAnsweringTwice() as { readonly code: string };
    expect(candidate.code).toBe(VERSION_FLOOR_EXCEEDED_CODE);
    expect(candidate.code).toBe(SECOND_READING_CODE);
  });

  it("sends a value whose every trap throws to the generic arm, and renders it", () => {
    // The arm selection is still correct for a value that carries no readable code at
    // all — the control on the two cases above, which would also be satisfied by a
    // view that had stopped recognizing anything.
    expect(() => {
      render(<MixedVersionStatus rosterEntry={null} writeAttemptRejection={everyTrapThrows()} />);
    }).not.toThrow();

    expect(screen.getByRole("alert", { name: "unrecognized-write-rejection" })).toBeDefined();
    expect(screen.queryByRole("alert", { name: "version-floor-write-refusal" })).toBeNull();
  });
});
