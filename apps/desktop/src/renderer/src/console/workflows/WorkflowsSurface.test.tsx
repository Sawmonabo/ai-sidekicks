// The scope model is legible before anything exists, and in resolution order — and
// the conversational start this surface mounts is handed the session it was given.
//
// The order is the daemon's rule rather than a layout choice, so it is asserted as
// a sequence read off the rendered markup and compared against the declared tuple —
// not against three hand-typed strings, which would be a second declaration of the
// same closed set and would agree with the first only until someone edited one.
//
// THE MOUNT IS OBSERVED THROUGH A SPY ON THE REAL WRAPPER, `ConsoleRoot.test.tsx`'s
// instrument and for its reason: `ChatStartSlot` is composed inside this surface and
// carries no body anywhere in this repository, so what the surface handed it reaches
// no rendered markup and there is no other way to read it back. Spied, never
// replaced — the real wrapper still renders, which is what the copy assertion beside
// each case reads off.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WORKFLOW_DEFINITION_SCOPES } from "../bridge/index.js";
import { refuse } from "../core/index.js";
import { ChatStartSlot } from "./ChatStartSlot.js";
import { WorkflowsSurface } from "./WorkflowsSurface.js";
import { refusedWorkflowChrome, unaskedWorkflowChrome } from "./chrome-state.js";
import { PROBE_SESSION_ID } from "./WorkflowsBrowser.test-support.js";

vi.mock(import("./ChatStartSlot.js"), { spy: true });

function renderSurface(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the surface rendered no section");
  }
  return section;
}

function scopeHeadings(section: HTMLElement): readonly string[] {
  return [...section.querySelectorAll(".meridian-workflow__scope-heading")].map(
    (heading) => heading.textContent ?? "",
  );
}

describe("definitions browser — the scope groups", () => {
  it("names all three groups in resolution order, so the scope model is legible", () => {
    const section = renderSurface(
      <WorkflowsSurface state={{ kind: "ready" }} sessionId={PROBE_SESSION_ID} />,
    );
    expect(scopeHeadings(section)).toStrictEqual([...WORKFLOW_DEFINITION_SCOPES]);
  });

  it("renders the groups in an ordered list, so the sequence survives without sight", () => {
    const section = renderSurface(
      <WorkflowsSurface state={{ kind: "ready" }} sessionId={PROBE_SESSION_ID} />,
    );
    expect(section.querySelector(".meridian-workflow__scopes")?.tagName).toBe("OL");
  });

  it("shows the groups on the `empty` arm too, so a read that found none still teaches", () => {
    const section = renderSurface(
      <WorkflowsSurface
        sessionId={PROBE_SESSION_ID}
        state={{ kind: "empty", title: "No definitions.", detail: "Start one." }}
      />,
    );
    expect(scopeHeadings(section)).toStrictEqual([...WORKFLOW_DEFINITION_SCOPES]);
  });

  it("negative control: a refused surface shows no groups at all", () => {
    // The cases above would pass over a surface that rendered its groups
    // unconditionally — including underneath a refusal, where the list it is
    // grouping was never obtained.
    const section = renderSurface(
      <WorkflowsSurface
        sessionId={PROBE_SESSION_ID}
        state={refusedWorkflowChrome(
          refuse("workflows-test", "workflow.not_found", "That definition is gone."),
        )}
      />,
    );
    expect(scopeHeadings(section)).toStrictEqual([]);
    expect(section.textContent).toContain("workflow.not_found");
  });

  it("says nobody asked, rather than that there are none, before the read", () => {
    const section = renderSurface(
      <WorkflowsSurface
        sessionId={PROBE_SESSION_ID}
        state={unaskedWorkflowChrome(
          "Definitions have not been read here.",
          "The read is elsewhere.",
        )}
      />,
    );
    expect(section.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(scopeHeadings(section)).toStrictEqual([]);
  });
});

describe("definitions browser — the entry points", () => {
  it("draws no control while nothing can author a definition", () => {
    expect(
      renderSurface(
        <WorkflowsSurface state={{ kind: "ready" }} sessionId={PROBE_SESSION_ID} />,
      ).querySelectorAll("button"),
    ).toHaveLength(0);
  });

  it("draws the controls it does have, so the case above is not an empty query", () => {
    // The floor under the case above, which would otherwise pass over a surface that
    // rendered no controls at all — including one whose whole body had failed to
    // mount. The continuation control is the one entry point this surface still has a
    // producer for, so it stands in for "a button reaches the markup".
    const section = renderSurface(
      <WorkflowsSurface
        state={{ kind: "ready" }}
        sessionId={PROBE_SESSION_ID}
        onContinueReading={() => undefined}
      />,
    );
    expect(
      [...section.querySelectorAll("button")].map((button) => button.textContent),
    ).toStrictEqual(["Show more definitions"]);
  });

  it("negative control: both authoring seams are gone from the type, not unsupplied", () => {
    // Compile-time on purpose. Deleting a dead prop leaves nothing to render, so no
    // rendered assertion can tell the deletion from a caller that simply never passed
    // it — which is how these seams survived this long. This reads the type instead:
    // on the surface as it was, which declared `onImportDefinition` and threaded it to
    // the `shared` group's empty state, and which threaded `onNewDefinition` into the
    // chrome's primary action, each suppression below has nothing to suppress and
    // `tsc` fails the file for an unused directive. That is the control, and the
    // repo's typecheck gate is what runs it.
    // Two renders and not one element carrying both: an excess-property check reports
    // the FIRST unknown member and stops, so a second directive beside the first
    // suppresses nothing and fails the file as unused — which would report the two
    // seams as one.
    const withImport = renderSurface(
      <WorkflowsSurface
        state={{ kind: "ready" }}
        sessionId={PROBE_SESSION_ID}
        // @ts-expect-error the surface declares no import entry point
        onImportDefinition={() => undefined}
      />,
    );
    const withAuthoring = renderSurface(
      <WorkflowsSurface
        state={{ kind: "ready" }}
        sessionId={PROBE_SESSION_ID}
        // @ts-expect-error the surface declares no authoring entry point
        onNewDefinition={() => undefined}
      />,
    );

    expect(withImport.querySelectorAll("button")).toHaveLength(0);
    expect(withAuthoring.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("definitions browser — the conversational start it mounts", () => {
  afterEach(() => {
    // By name rather than `clearAllMocks`, so a case reads only the render it made.
    vi.mocked(ChatStartSlot).mockClear();
  });

  it("hands the mount the session the surface was given", () => {
    const section = renderSurface(
      <WorkflowsSurface state={{ kind: "ready" }} sessionId={PROBE_SESSION_ID} />,
    );
    // The obligation the slot is under: every mount supplies the session a start
    // binds to. A raw slot mount carries no payload at all, so this reads
    // `undefined` on a surface that mounts one.
    expect(vi.mocked(ChatStartSlot).mock.calls[0]?.[0]).toStrictEqual({
      sessionId: PROBE_SESSION_ID,
    });
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(1);
  });

  it("hands over an absent session as an absent one, and still reserves the area", () => {
    // A bare rail address names no session, which the surface has to say rather than
    // drop: the body can tell that apart from a surface that never looked.
    const section = renderSurface(
      <WorkflowsSurface state={{ kind: "ready" }} sessionId={undefined} />,
    );
    expect(vi.mocked(ChatStartSlot).mock.calls[0]?.[0]).toStrictEqual({ sessionId: undefined });
    expect(section.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it("negative control: the reservation is worded by the wrapper, not by this surface", () => {
    // Both cases above would pass over a surface that mounted the wrapper and never
    // rendered it. This reads the wrapper's OWN copy off the markup — the sentence
    // the run pane's mount shows too, and one this surface's raw mount never wrote.
    const section = renderSurface(
      <WorkflowsSurface state={{ kind: "ready" }} sessionId={PROBE_SESSION_ID} />,
    );
    expect(section.textContent ?? "").toContain("the composer's own affordance");
  });
});
