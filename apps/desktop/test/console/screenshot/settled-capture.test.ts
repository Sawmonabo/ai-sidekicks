// The capture refusal's own controls.
//
// A CLEAN RESULT IS WORTH NOTHING WITHOUT A PLANTED FAILURE, which is the package's
// rule and is doubly true here: the whole point of `assertNoPendingPaneBodies` is that
// it fires on a state the tier is otherwise green under, so a suite that only ever
// handed it an empty list would prove exactly what a function returning `undefined`
// unconditionally proves.
//
// THE PURE HALF IS WHAT IS DRIVEN. `captureSettled` composes the DOM read with this
// refusal; the read has its own controls beside the marker it reads
// (`console/seats/pending-pane-body.test.ts`), and driving the composed function here
// would mean minting a real half-loaded capture, which is the thing it exists to
// prevent.

import { describe, expect, it } from "vitest";

import { assertNoPendingPaneBodies } from "./settled-capture.js";

describe("the screenshot tier's pending-body refusal", () => {
  it("passes a capture whose panes have all loaded", () => {
    expect(() => {
      assertNoPendingPaneBodies([], "repos-diff-pane-light");
    }).not.toThrow();
  });

  // The planted failure. One pending kind, which is the smallest bad input there is.
  it("refuses a capture with one pending pane body, and names the kind", () => {
    expect(() => {
      assertNoPendingPaneBodies(["workflow-run"], "workflows-run-pane-light");
    }).toThrowError(/workflow-run/u);
  });

  // The reference name is in the message because a tier that pins fourteen references
  // reports a failure with no other way to say which one was being taken.
  it("names the reference it refused", () => {
    expect(() => {
      assertNoPendingPaneBodies(["diff"], "repos-diff-pane-dark");
    }).toThrowError(/repos-diff-pane-dark/u);
  });

  it("counts every pending body rather than reporting the first", () => {
    expect(() => {
      assertNoPendingPaneBodies(["diff", "artifact"], "repos-section-light");
    }).toThrowError(/2 pane body\/bodies/u);
  });
});
