// The one composition every plan-owned slot in this family goes through.
//
// It was written five times — once per wrapper — and each copy decided for itself
// whether a body was present, whether the mount obligation could be met, and how the
// body was turned into a subtree. This file is what makes the single copy checkable:
// the wrappers' own suites assert what each of them PROMISES its body, and these cases
// assert what the mount DOES with a body and a promise once it has them.

import { render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { WORKFLOW_CHAT_START_SLOT } from "./owner-slots.js";
import { WorkflowSlotMount } from "./WorkflowSlotMount.js";

interface ProbeMount {
  readonly sessionId: string;
}

const PROBE_MOUNT: ProbeMount = { sessionId: "ses-slot-mount" };

const RESERVED_COPY = {
  title: "The probe body is not built yet.",
  detail: "This area is reserved for a body another plan authors.",
};

describe("a plan-owned slot's mount", () => {
  it("renders the reserved absence while no body has been supplied", () => {
    const { container } = render(
      <WorkflowSlotMount
        seat={WORKFLOW_CHAT_START_SLOT}
        body={undefined}
        mount={PROBE_MOUNT}
        {...RESERVED_COPY}
      />,
    );
    expect(container.querySelectorAll(".meridian-workflow__slot")).toHaveLength(1);
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it("renders a supplied body, and hands it the mount verbatim", () => {
    // The claim the old shape could not make. Each wrapper composed its body from its
    // own optional prop while the seat published a `body` member no mount ever read —
    // so a seat whose body was filled went on rendering this same reserved absence.
    const body = vi.fn((mount: ProbeMount) => <p>probe body for {mount.sessionId}</p>);
    const { container } = render(
      <WorkflowSlotMount
        seat={WORKFLOW_CHAT_START_SLOT}
        body={body}
        mount={PROBE_MOUNT}
        {...RESERVED_COPY}
      />,
    );
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
    expect(container.textContent).toContain("probe body for ses-slot-mount");
    expect(body.mock.calls[0]?.[0]).toStrictEqual(PROBE_MOUNT);
  });

  it("renders the reserved absence when the mount obligation cannot be met", () => {
    // One rule stated once, where the human form used to state it alone: a body
    // composed against an obligation nobody could supply would be answerable in
    // appearance and unsubmittable in fact.
    const body = vi.fn((mount: ProbeMount) => <p>probe body for {mount.sessionId}</p>);
    const { container } = render(
      <WorkflowSlotMount
        seat={WORKFLOW_CHAT_START_SLOT}
        body={body}
        mount={undefined}
        {...RESERVED_COPY}
      />,
    );
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(body).not.toHaveBeenCalled();
  });

  it("gives the body its own hook boundary across the conditional", () => {
    // The rule the header states, driven rather than asserted: a body holding a hook
    // is mounted and unmounted as the mount obligation comes and goes. Called instead
    // of rendered — the shape a wrapper reaches for — the body's hook would join the
    // mount's own list on the render where the branch is first taken, which is
    // React's hook-order error.
    function StatefulBody(mount: ProbeMount): React.JSX.Element {
      const [seen] = useState(mount.sessionId);
      return <p>held {seen}</p>;
    }
    const { container, rerender } = render(
      <WorkflowSlotMount
        seat={WORKFLOW_CHAT_START_SLOT}
        body={StatefulBody}
        mount={undefined}
        {...RESERVED_COPY}
      />,
    );
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    rerender(
      <WorkflowSlotMount
        seat={WORKFLOW_CHAT_START_SLOT}
        body={StatefulBody}
        mount={PROBE_MOUNT}
        {...RESERVED_COPY}
      />,
    );
    expect(container.textContent).toContain("held ses-slot-mount");
  });

  it("renders none of the seat's governance prose, on either arm", () => {
    const seatless = render(
      <WorkflowSlotMount
        seat={WORKFLOW_CHAT_START_SLOT}
        body={undefined}
        mount={PROBE_MOUNT}
        {...RESERVED_COPY}
      />,
    );
    const filled = render(
      <WorkflowSlotMount
        seat={WORKFLOW_CHAT_START_SLOT}
        body={() => <p>probe body</p>}
        mount={PROBE_MOUNT}
        {...RESERVED_COPY}
      />,
    );
    expect(seatless.container.textContent ?? "").not.toContain("Plan-017");
    expect(filled.container.textContent ?? "").not.toContain("Plan-017");
    // Negative control: the seat really does carry that prose, so neither case above
    // holds over a contract that named nobody.
    expect(WORKFLOW_CHAT_START_SLOT.owningTask).toContain("Plan-017");
  });
});
