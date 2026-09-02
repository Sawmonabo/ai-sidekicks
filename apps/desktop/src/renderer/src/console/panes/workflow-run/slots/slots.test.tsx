// The three Plan-017 slots, checked on the two things a slot owes.
//
//   1. **The shell stands while nobody has filled it**, and says the feature has
//      not been built — never a shape that reads as a broken one, and never a word
//      of the governance prose the contract carries.
//   2. **The mount obligation is delivered.** A slot's props type is a promise
//      about what the body receives, and a promise nothing checks is prose. Each
//      case below supplies a body and reads back exactly what arrived.
//
// One file for the three because they are one claim asserted three times; three
// files would be the same imports and the same two cases copied twice.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  WORKFLOW_CHAT_START_SLOT,
  WORKFLOW_HUMAN_FORM_SLOT,
  WORKFLOW_RUN_DETAIL_SLOT,
} from "../../../workflows/owner-slots.js";
import { ChatStartSlot } from "./ChatStartSlot.js";
import { HumanFormSlot, type HumanFormMount } from "./HumanFormSlot.js";
import { RunDetailSlot } from "./RunDetailSlot.js";

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
  it("hands the run detail the run and nothing else", () => {
    const body = vi.fn(() => <p>run detail body</p>);
    const { container } = render(<RunDetailSlot workflowRunId="wfr-01" body={body} />);
    expect(body).toHaveBeenCalledWith({ workflowRunId: "wfr-01" });
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("hands the human form the open phase, revision included", () => {
    const body = vi.fn(() => <p>form body</p>);
    render(<HumanFormSlot phase={OPEN_PHASE} body={body} />);
    expect(body).toHaveBeenCalledWith(OPEN_PHASE);
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
    const body = vi.fn(() => <p>start body</p>);
    render(<ChatStartSlot sessionId="session-01" body={body} />);
    // The originating channel is provenance the client derives from where the
    // conversation is — never typed by a person and never supplied by a tool — so
    // it is absent from this mount by design rather than by omission.
    expect(body).toHaveBeenCalledWith({ sessionId: "session-01" });
  });

  it("negative control: an unfilled slot calls nothing and keeps its shell", () => {
    const body = vi.fn(() => <p>run detail body</p>);
    const { container } = render(<RunDetailSlot workflowRunId="wfr-01" />);
    expect(body).not.toHaveBeenCalled();
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });
});
