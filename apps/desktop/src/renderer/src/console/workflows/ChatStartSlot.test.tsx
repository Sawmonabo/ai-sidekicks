// The conversational start's slot, on the two things every slot owes and on the one
// thing that is only true of this one.
//
//   1. **The shell stands while nobody has filled it**, and says the feature has not
//      been built — never a shape that reads as a broken one, and never a word of the
//      governance prose the contract carries.
//   2. **The mount obligation is delivered.** The slot's props type is a promise
//      about what the body receives, and a promise nothing checks is prose.
//   3. **The session travels even when there is none.** This is the required-carrying-
//      undefined rule made observable: a surface that could not resolve a session has
//      to hand over that fact, and a dropped key would read to the body exactly like a
//      surface that never looked.
//
// This file sits beside the wrapper rather than inside either mounting directory,
// because the wrapper does: two surfaces mount it — the definitions browser and the
// run pane's empty arm — and the sibling cases for the four single-consumer slots
// stay in `panes/workflow-run/slots/slots.test.tsx`, where those slots live.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatStartSlot, type ChatStartMount } from "./ChatStartSlot.js";
import { WORKFLOW_CHAT_START_SLOT } from "./owner-slots.js";

const PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";

describe("the conversational start is reserved, not stubbed", () => {
  it("stands in its own mount with an empty absence", () => {
    const { container } = render(<ChatStartSlot sessionId={PROBE_SESSION_ID} />);
    expect(container.querySelectorAll(".meridian-workflow__slot")).toHaveLength(1);
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it("renders none of the contract's governance prose", () => {
    const { container } = render(<ChatStartSlot sessionId={PROBE_SESSION_ID} />);
    expect(container.textContent ?? "").not.toContain("Plan-017");
  });

  it("negative control: the contract really does carry that prose, so the case is not vacuous", () => {
    // Without this, the case above would hold over a component that rendered the
    // whole contract verbatim, had the contract simply named nobody.
    expect(WORKFLOW_CHAT_START_SLOT.contract.owningTask).toContain("Plan-017");
    expect(WORKFLOW_CHAT_START_SLOT.body).toBeUndefined();
  });
});

describe("the conversational start receives exactly what the mount promised", () => {
  // Read off the first call's first argument rather than through
  // `toHaveBeenCalledWith`: React owns the argument list of a component it renders,
  // and an assertion on its ARITY would be a claim about React rather than about the
  // mount this file is checking.
  it("hands the conversational start the session and no channel", () => {
    const body = vi.fn((_mount: ChatStartMount) => <p>start body</p>);
    const { container } = render(<ChatStartSlot sessionId={PROBE_SESSION_ID} body={body} />);
    // The originating channel is provenance the client derives from where the
    // conversation is — never typed by a person and never supplied by a tool — so
    // it is absent from this mount by design rather than by omission.
    expect(body.mock.calls[0]?.[0]).toStrictEqual({ sessionId: PROBE_SESSION_ID });
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("hands over an unresolved session as an absent one, rather than dropping the key", () => {
    // The whole point of the required-carrying-undefined member: a mount on a route
    // with no session says so, and the body can tell that apart from a mount that
    // forgot to look — which is what a dropped key would be indistinguishable from.
    const body = vi.fn((_mount: ChatStartMount) => <p>start body</p>);
    render(<ChatStartSlot sessionId={undefined} body={body} />);
    expect(body.mock.calls[0]?.[0]).toStrictEqual({ sessionId: undefined });
    expect(Object.hasOwn(body.mock.calls[0]?.[0] ?? {}, "sessionId")).toBe(true);
  });

  it("negative control: an unfilled slot calls nothing and keeps its shell", () => {
    const body = vi.fn(() => <p>start body</p>);
    const { container } = render(<ChatStartSlot sessionId={PROBE_SESSION_ID} />);
    expect(body).not.toHaveBeenCalled();
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });
});
