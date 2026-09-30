// The conversational start's mount point: the frame stands empty while nobody has filled it, the
// body receives exactly the mount props type promises, and the session travels even when there
// is none. The other mount points are in `run-mount-points.test.tsx`.

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
  // Read off the first call's first argument, not `toHaveBeenCalledWith`: React owns the
  // argument list of a component it renders, so its arity is not what this file checks.
  it("hands the conversational start the session", () => {
    const body = vi.fn((_mount: ChatStartMount) => <p>start body</p>);
    const { container } = render(<ChatStartMountPoint sessionId={PROBE_SESSION_ID} body={body} />);
    expect(body.mock.calls[0]?.[0]).toStrictEqual({ sessionId: PROBE_SESSION_ID });
    expect(container.textContent).toContain("start body");
  });

  it("hands over an unresolved session as an absent one, rather than dropping the key", () => {
    // A mount on a route with no session says so, and a dropped key would be indistinguishable
    // from a mount that forgot to look.
    const body = vi.fn((_mount: ChatStartMount) => <p>start body</p>);
    render(<ChatStartMountPoint sessionId={undefined} body={body} />);
    expect(body.mock.calls[0]?.[0]).toStrictEqual({ sessionId: undefined });
    expect(Object.hasOwn(body.mock.calls[0]?.[0] ?? {}, "sessionId")).toBe(true);
  });
});
