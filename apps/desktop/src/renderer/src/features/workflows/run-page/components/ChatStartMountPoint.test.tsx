// The conversational start's mount point, on the two things every mount point owes and on the one thing that
// is only true of this one.
//
//   1. **The frame stands while nobody has filled it**, empty.
//   2. **The mount obligation is delivered.** The mount point's props type is a promise about what
//      the body receives, and a promise nothing checks is prose.
//   3. **The session travels even when there is none.** This is the required-carrying-
//      undefined rule made observable: a surface that could not resolve a session has to
//      hand over that fact, and a dropped key would read to the body exactly like a surface
//      that never looked.
//
// The cases for the other mount points in this folder are `run-mount-points.test.tsx`.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatStartMountPoint, type ChatStartMount } from "./ChatStartMountPoint.js";
import { PROBE_SESSION_ID } from "../../workflows-probe.test-support.js";

describe("the conversational start's frame", () => {
  it("stands empty while no body is supplied", () => {
    const { container } = render(<ChatStartMountPoint sessionId={PROBE_SESSION_ID} />);
    const frames = container.querySelectorAll(".meridian-workflow__mount-point");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.textContent).toBe("");
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });
});

describe("the conversational start receives exactly what the mount promised", () => {
  // Read off the first call's first argument rather than through
  // `toHaveBeenCalledWith`: React owns the argument list of a component it renders,
  // and an assertion on its ARITY would be a claim about React rather than about the
  // mount this file is checking.
  it("hands the conversational start the session", () => {
    const body = vi.fn((_mount: ChatStartMount) => <p>start body</p>);
    const { container } = render(<ChatStartMountPoint sessionId={PROBE_SESSION_ID} body={body} />);
    expect(body.mock.calls[0]?.[0]).toStrictEqual({ sessionId: PROBE_SESSION_ID });
    expect(container.textContent).toContain("start body");
  });

  it("hands over an unresolved session as an absent one, rather than dropping the key", () => {
    // The whole point of the required-carrying-undefined member: a mount on a route
    // with no session says so, and the body can tell that apart from a mount that
    // forgot to look — which is what a dropped key would be indistinguishable from.
    const body = vi.fn((_mount: ChatStartMount) => <p>start body</p>);
    render(<ChatStartMountPoint sessionId={undefined} body={body} />);
    expect(body.mock.calls[0]?.[0]).toStrictEqual({ sessionId: undefined });
    expect(Object.hasOwn(body.mock.calls[0]?.[0] ?? {}, "sessionId")).toBe(true);
  });
});
