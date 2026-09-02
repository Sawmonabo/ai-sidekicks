// The three Plan-017 slots, checked on the two things a slot owes.
//
//   1. **The shell stands while nobody has filled it**, and says the feature has
//      not been built — never a shape that reads as a broken one, and never a word
//      of the governance prose the contract carries.
//   2. **The mount obligation is delivered.** A slot's props type is a promise
//      about what the body receives, and a promise nothing checks is prose. Each
//      case below supplies a body and reads back exactly what arrived.
//
// And on one thing every slot wrapper owes React: a supplied body is RENDERED and
// never called, so its hooks belong to it. The last describe drives that across the
// conditional transition where a called body's hooks would first join the wrapper's
// list, with the call shape the wrappers no longer use as its control.
//
// One file for the three because they are one claim asserted three times; three
// files would be the same imports and the same two cases copied twice.

import { render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  WORKFLOW_CHAT_START_SLOT,
  WORKFLOW_HUMAN_FORM_SLOT,
  WORKFLOW_RUN_DETAIL_SLOT,
} from "../../../workflows/owner-slots.js";
import { ChatStartSlot, type ChatStartMount } from "./ChatStartSlot.js";
import { HumanFormSlot, type HumanFormMount } from "./HumanFormSlot.js";
import { RunDetailSlot, type RunDetailMount } from "./RunDetailSlot.js";

const OPEN_PHASE: HumanFormMount = {
  phaseRunId: "phase-run-01",
  phaseId: "review",
  // `0` on purpose: it is the value a falsy discriminator would drop, and the one a
  // fresh attempt actually carries.
  formRevision: 0,
};

/** Every slot's unfilled rendering, as one table so a fourth cannot skip a case. */
const UNFILLED_SLOTS: readonly (readonly [string, React.JSX.Element])[] = [
  ["run detail", <RunDetailSlot key="run-detail" workflowRunId="wfr-01" />],
  ["human form", <HumanFormSlot key="human-form" phase={undefined} />],
  ["chat start", <ChatStartSlot key="chat-start" sessionId="session-01" />],
];

describe("an unfilled slot is reserved, not stubbed", () => {
  it.each(UNFILLED_SLOTS)("%s stands in its own mount with an empty absence", (_name, element) => {
    const { container } = render(element);
    expect(container.querySelectorAll(".meridian-workflow__slot")).toHaveLength(1);
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it.each(UNFILLED_SLOTS)(
    "%s renders none of the contract's governance prose",
    (_name, element) => {
      const { container } = render(element);
      expect(container.textContent ?? "").not.toContain("Plan-017");
    },
  );

  it("negative control: the contracts really do carry that prose, so the case is not vacuous", () => {
    // Every contract names its owning task. If none did, the assertion above would
    // hold over a component that rendered the whole contract verbatim.
    for (const slot of [
      WORKFLOW_RUN_DETAIL_SLOT,
      WORKFLOW_HUMAN_FORM_SLOT,
      WORKFLOW_CHAT_START_SLOT,
    ]) {
      expect(slot.contract.owningTask).toContain("Plan-017");
      expect(slot.body).toBeUndefined();
    }
  });
});

describe("a filled slot receives exactly what the mount promised", () => {
  // Read off the first call's first argument rather than through
  // `toHaveBeenCalledWith`: React owns the argument list of a component it renders,
  // and an assertion on its ARITY would be a claim about React rather than about the
  // mount this file is checking.
  it("hands the run detail the run and nothing else", () => {
    const body = vi.fn((_mount: RunDetailMount) => <p>run detail body</p>);
    const { container } = render(<RunDetailSlot workflowRunId="wfr-01" body={body} />);
    expect(body.mock.calls[0]?.[0]).toStrictEqual({ workflowRunId: "wfr-01" });
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("hands the human form the open phase, revision included", () => {
    const body = vi.fn((_mount: HumanFormMount) => <p>form body</p>);
    render(<HumanFormSlot phase={OPEN_PHASE} body={body} />);
    expect(body.mock.calls[0]?.[0]).toStrictEqual(OPEN_PHASE);
  });

  it("calls no human-form body while no phase is open", () => {
    // A form rendered against a phase nobody resolved would be answerable in
    // appearance and unsubmittable in fact, so the body is not called at all rather
    // than called with a placeholder.
    const body = vi.fn(() => <p>form body</p>);
    const { container } = render(<HumanFormSlot phase={undefined} body={body} />);
    expect(body).not.toHaveBeenCalled();
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it("hands the conversational start the session and no channel", () => {
    const body = vi.fn((_mount: ChatStartMount) => <p>start body</p>);
    render(<ChatStartSlot sessionId="session-01" body={body} />);
    // The originating channel is provenance the client derives from where the
    // conversation is — never typed by a person and never supplied by a tool — so
    // it is absent from this mount by design rather than by omission.
    expect(body.mock.calls[0]?.[0]).toStrictEqual({ sessionId: "session-01" });
  });

  it("negative control: an unfilled slot calls nothing and keeps its shell", () => {
    const body = vi.fn(() => <p>run detail body</p>);
    const { container } = render(<RunDetailSlot workflowRunId="wfr-01" />);
    expect(body).not.toHaveBeenCalled();
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });
});

describe("a body that uses hooks keeps its own hook boundary", () => {
  const SECOND_PHASE: HumanFormMount = {
    phaseRunId: "phase-run-02",
    phaseId: "sign-off",
    formRevision: 1,
  };

  /**
   * A body with state and an effect, which is what makes the boundary observable.
   *
   * Declared once rather than inside a case, because a component composed on each
   * render is a new type each time and React remounts it — the reciprocal obligation
   * `owner-slots.ts` states. The effect's teardown is the fact under test: a real
   * Plan-017 body opens a subscription there.
   */
  function statefulFormBody(recordTeardown: () => void) {
    return function StatefulFormBody(mount: HumanFormMount): React.JSX.Element {
      const [composedAgainstPhaseId] = useState(mount.phaseId);
      useEffect(() => recordTeardown, []);
      return <p>{composedAgainstPhaseId}</p>;
    };
  }

  it("tears the body down when the phase closes and reopens it on the next one", () => {
    const recordTeardown = vi.fn();
    const body = statefulFormBody(recordTeardown);
    const { rerender, container } = render(<HumanFormSlot phase={undefined} body={body} />);
    rerender(<HumanFormSlot phase={OPEN_PHASE} body={body} />);
    expect(container.textContent).toContain(OPEN_PHASE.phaseId);

    rerender(<HumanFormSlot phase={undefined} body={body} />);
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(recordTeardown).toHaveBeenCalledTimes(1);

    rerender(<HumanFormSlot phase={SECOND_PHASE} body={body} />);
    expect(container.textContent).toContain(SECOND_PHASE.phaseId);
    expect(container.textContent).not.toContain(OPEN_PHASE.phaseId);
  });

  /**
   * The shape the wrappers no longer use, reconstructed here and nowhere in `src/`.
   *
   * Calling the body inline puts its hooks into the WRAPPER's list, which is what the
   * two controls below read off from opposite sides. The wrapper carries one hook of
   * its own because that is what makes the mixing observable at all: React reads a
   * render that calls no hook as a mount, so a wrapper with no hooks hides the
   * violation until it grows one — precisely the state these wrappers were in.
   */
  function directCallHumanFormSlot(body: (mount: HumanFormMount) => React.JSX.Element) {
    return function DirectCallHumanFormSlot(props: {
      readonly phase: HumanFormMount | undefined;
    }): React.JSX.Element {
      const openForm = props.phase === undefined ? null : body(props.phase);
      const [slotLabel] = useState("human form");
      return (
        <div>
          {openForm}
          {slotLabel}
        </div>
      );
    };
  }

  it("negative control: the direct-call shape refuses the render the phase clears on", () => {
    // Without this, the case above would pass over a wrapper that had never been at
    // risk. The body's `useState` sits in the wrapper's own hook list, which is two
    // long while a phase is open and one long when it clears — and React refuses the
    // shorter render rather than guessing which hook went missing.
    const recordTeardown = vi.fn();
    const DirectCallSlot = directCallHumanFormSlot(statefulFormBody(recordTeardown));
    const { rerender } = render(<DirectCallSlot phase={OPEN_PHASE} />);
    const reportedErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => {
        rerender(<DirectCallSlot phase={undefined} />);
      }).toThrow(/hook/iu);
    } finally {
      reportedErrors.mockRestore();
    }
  });
});
