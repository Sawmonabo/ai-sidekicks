// The composition every workflows mount point goes through: whether a body is present, whether
// the mount obligation could be met, and how the body becomes a subtree.

import { render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { EngineMountPoint } from "./EngineMountPoint.js";

interface ProbeMount {
  readonly sessionId: string;
}

const PROBE_MOUNT: ProbeMount = { sessionId: "ses-mount-point" };

/** Assert the frame stands once and holds nothing: no text and no absence block. */
function expectEmptyFrame(container: HTMLElement): void {
  const frames = container.querySelectorAll(".meridian-workflow__mount-point");
  expect(frames).toHaveLength(1);
  expect(frames[0]?.textContent).toBe("");
  expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
}

describe("a mount point's mount", () => {
  it("draws an empty frame while no body has been supplied", () => {
    const { container } = render(<EngineMountPoint body={undefined} mount={PROBE_MOUNT} />);
    expectEmptyFrame(container);
  });

  it("renders a supplied body, and hands it the mount verbatim", () => {
    const body = vi.fn((mount: ProbeMount) => <p>probe body for {mount.sessionId}</p>);
    const { container } = render(<EngineMountPoint body={body} mount={PROBE_MOUNT} />);
    expect(container.textContent).toContain("probe body for ses-mount-point");
    expect(body.mock.calls[0]?.[0]).toStrictEqual(PROBE_MOUNT);
  });

  it("draws an empty frame when the mount obligation cannot be met", () => {
    const body = vi.fn((mount: ProbeMount) => <p>probe body for {mount.sessionId}</p>);
    const { container } = render(<EngineMountPoint body={body} mount={undefined} />);
    expectEmptyFrame(container);
    expect(body).not.toHaveBeenCalled();
  });

  it("gives the body its own hook boundary across the conditional", () => {
    // Called instead of rendered, a body's hook would join the mount's own hook list when the
    // branch is first taken, which is React's hook-order error.
    function StatefulBody(mount: ProbeMount): React.JSX.Element {
      const [seen] = useState(mount.sessionId);
      return <p>held {seen}</p>;
    }
    const { container, rerender } = render(
      <EngineMountPoint body={StatefulBody} mount={undefined} />,
    );
    expectEmptyFrame(container);
    rerender(<EngineMountPoint body={StatefulBody} mount={PROBE_MOUNT} />);
    expect(container.textContent).toContain("held ses-mount-point");
  });
});
