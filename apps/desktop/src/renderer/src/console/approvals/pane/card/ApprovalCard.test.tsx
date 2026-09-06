// The card's four hard claims: two answers and no third, an expiry that is either
// verbatim or explicitly absent, a remember opt-in that sends nothing until it is
// engaged, and an action row a keyboard can walk.
//
// The payload assertions drive the REAL `onResolve` the component calls, so what is
// checked is the request that would go on the wire rather than a re-derivation of
// it beside the component.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApprovalCard } from "./ApprovalCard.js";
import { ACCENT_FILL_CLASS } from "../../../primitives/index.js";
import { type ApprovalRecord } from "../../../bridge/index.js";
import { type ApprovalResolveRequest } from "../approvals-wire.js";

function pendingRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    approvalRequestId: "approval-01",
    runId: "run-01",
    category: "file_write",
    state: "pending",
    requestedBy: "agent-implementer",
    requestedScope: "session",
    resourceDescriptor: { path: "packages/contracts/src/approval.ts" },
    createdAt: "2026-01-01T13:30:00.900Z",
    updatedAt: "2026-01-01T13:30:00.900Z",
    ...overrides,
  };
}

/**
 * Engage the remember opt-in the way a person does — by clicking its label.
 *
 * The label rather than the `role="checkbox"` element: the visible control is a
 * `span` whose state lives on a hidden native input inside the same label, so a
 * click on the span alone is not the activation a pointer performs.
 */
function engageRememberOptIn(): void {
  fireEvent.click(screen.getByRole("button", { name: "Remember this answer" }));
  fireEvent.click(screen.getByText("Remember my approval for this category"));
}

/** The optional narrowing field, by its label rather than by its markup. */
function patternField(): HTMLInputElement {
  const field = screen.getByLabelText("Narrow it to a pattern (optional)");
  if (!(field instanceof HTMLInputElement)) {
    throw new Error("the narrowing control is not a text field");
  }
  return field;
}

/**
 * Whether a sentence promises a matching grammar the corpus has not registered.
 *
 * The registered contract says one thing about the pattern — it is matched against
 * the resource within the boundary — and registers no per-category syntax, so copy
 * that names one is copy making a promise the daemon never made.
 */
function namesAMatchingSyntax(copy: string): boolean {
  return ["glob", "wildcard", "regex", "prefix", "*", "://"].some((token) =>
    copy.toLowerCase().includes(token),
  );
}

function renderCard(record: ApprovalRecord, isResolving = false): ApprovalResolveRequest[] {
  const requests: ApprovalResolveRequest[] = [];
  render(
    <ApprovalCard
      record={record}
      isResolving={isResolving}
      refusal={undefined}
      onResolve={(request) => requests.push(request)}
    />,
  );
  return requests;
}

describe("the two answers", () => {
  it("offers exactly Approve and Reject on a pending record", () => {
    renderCard(pendingRecord());
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    const labels = [...actions.querySelectorAll("button")].map((button) => button.textContent);
    expect(labels).toStrictEqual(["Approve", "Reject"]);
  });

  it("offers no answer at all on a resolved record", () => {
    // Negative control for the case above: the toolbar has to be absent here, or
    // "exactly two" would be a claim about a row that is always rendered.
    renderCard(pendingRecord({ state: "approved" }));
    expect(screen.queryByRole("toolbar", { name: "Answer this request" })).toBeNull();
  });

  it("disables both actions while this record's call is in flight", () => {
    renderCard(pendingRecord(), true);
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    for (const button of actions.querySelectorAll("button")) {
      expect(button.disabled).toBe(true);
    }
  });

  it("gives approve the filled accent and leaves reject quiet", () => {
    renderCard(pendingRecord());
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });

    // The face comes from the primitives rather than from this pane's sheet, which
    // is what makes the ink measurable: `tokens/contrast.test.ts` measures
    // `accent-ink` against the fill, and a control painting its own accent is a
    // pairing that measurement never sees.
    expect(within(actions).getByRole("button", { name: "Approve" }).classList).toContain(
      ACCENT_FILL_CLASS,
    );

    // The negative control, and rule 1 itself: one primary action per surface. A
    // reject that also carried the fill would be a second — and reject is never
    // coloured at all, because a rejection is the console working.
    expect(within(actions).getByRole("button", { name: "Reject" }).classList).not.toContain(
      ACCENT_FILL_CLASS,
    );
  });
});

describe("the remembered-scope opt-in", () => {
  it("omits `rememberedScope` entirely when the control was never engaged", () => {
    const requests = renderCard(pendingRecord());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toStrictEqual({
      approvalRequestId: "approval-01",
      decision: "approved",
      effectiveScope: "session",
    });
    expect(requests[0] && "rememberedScope" in requests[0]).toBe(false);
  });

  it("never sends a remembered scope on the reject path", () => {
    const requests = renderCard(pendingRecord());
    engageRememberOptIn();
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(requests[0]?.decision).toBe("rejected");
    expect(requests[0]?.rememberedScope).toBeUndefined();
  });

  it("sends the ratified scope kind once the opt-in is engaged and approved", () => {
    const requests = renderCard(pendingRecord());
    engageRememberOptIn();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(requests[0]?.rememberedScope).toStrictEqual({ kind: "run" });
  });

  it("omits `pattern` entirely when the field was left empty", () => {
    const requests = renderCard(pendingRecord());
    engageRememberOptIn();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const remembered = requests[0]?.rememberedScope;
    expect(remembered).toStrictEqual({ kind: "run" });
    // The key has to be ABSENT rather than falsy: an absent pattern means
    // category-wide on the wire and an empty string means nothing at all there.
    expect(remembered !== undefined && "pattern" in remembered).toBe(false);
  });

  it("sends what was typed verbatim, whitespace included", () => {
    const requests = renderCard(pendingRecord());
    engageRememberOptIn();
    fireEvent.change(patternField(), { target: { value: "  packages/contracts  " } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    // Trimming would send the daemon something other than what was typed, and what
    // a pattern matches is the daemon's to decide.
    expect(requests[0]?.rememberedScope).toStrictEqual({
      kind: "run",
      pattern: "  packages/contracts  ",
    });
  });

  it("never sends a pattern on the reject path", () => {
    const requests = renderCard(pendingRecord());
    engageRememberOptIn();
    fireEvent.change(patternField(), { target: { value: "packages/contracts" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(requests[0]?.rememberedScope).toBeUndefined();
  });

  it("leaves the pattern unreachable until the opt-in is engaged", () => {
    renderCard(pendingRecord());
    fireEvent.click(screen.getByRole("button", { name: "Remember this answer" }));
    // Negative control on the assertion above: the field exists and is refused,
    // rather than being absent and vacuously unreachable.
    expect(patternField().disabled).toBe(true);
    fireEvent.click(screen.getByText("Remember my approval for this category"));
    expect(patternField().disabled).toBe(false);
  });

  it("promises no matching syntax anywhere in its copy", () => {
    renderCard(pendingRecord());
    fireEvent.click(screen.getByRole("button", { name: "Remember this answer" }));
    const note = screen.getByText(/matched against the resource/u);
    expect(namesAMatchingSyntax(note.textContent ?? "")).toBe(false);
    // Negative control on the checker itself: copy that DOES promise a grammar has
    // to be caught, or the assertion above passes on any string at all.
    expect(namesAMatchingSyntax("Use a glob like packages/**")).toBe(true);
  });

  it("never widens the scope beyond what was requested", () => {
    const requests = renderCard(pendingRecord({ requestedScope: "run" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(requests[0]?.effectiveScope).toBe("run");
  });
});

describe("expiry is verbatim or explicitly absent", () => {
  it("shows the wire value exactly as sent", () => {
    renderCard(pendingRecord({ expiryAt: "2026-01-01T17:30:00.900Z" }));
    expect(screen.getByText("2026-01-01T17:30:00.900Z")).not.toBeNull();
  });

  it("says 'no expiry' rather than leaving the field blank", () => {
    renderCard(pendingRecord());
    expect(screen.getByText("No expiry")).not.toBeNull();
    // Negative control: the absent case must not also render a timestamp, or the
    // two arms would be indistinguishable to this assertion.
    expect(screen.queryByText("2026-01-01T17:30:00.900Z")).toBeNull();
  });
});

describe("the resolved quad", () => {
  it("renders all four members when the reply carried them", () => {
    renderCard(
      pendingRecord({
        state: "approved",
        resolvedAt: "2026-01-01T13:30:00.420Z",
        decision: "approved",
        approverId: "participant-you",
        effectiveScope: "run",
      }),
    );
    expect(screen.getByText("2026-01-01T13:30:00.420Z")).not.toBeNull();
    expect(screen.getByText("participant-you")).not.toBeNull();
  });

  it("says the record is incomplete rather than rendering it as whole", () => {
    renderCard(pendingRecord({ state: "rejected", decision: "rejected" }));
    expect(screen.getByText(/less than what happened/u)).not.toBeNull();
  });
});

describe("the action row is keyboard-walkable", () => {
  it("moves focus with an arrow and with a vim key, and suppresses the page scroll", () => {
    renderCard(pendingRecord());
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    const approve = screen.getByRole("button", { name: "Approve" });
    const reject = screen.getByRole("button", { name: "Reject" });
    approve.focus();
    const arrowHandled = fireEvent.keyDown(actions, { key: "ArrowRight" });
    expect(document.activeElement).toBe(reject);
    // `fireEvent` answers false when a handler called `preventDefault`, which is
    // the page-scroll suppression this row promises.
    expect(arrowHandled).toBe(false);
    fireEvent.keyDown(actions, { key: "h" });
    expect(document.activeElement).toBe(approve);
  });

  it("negative control: a key the row does not own moves nothing and is not suppressed", () => {
    renderCard(pendingRecord());
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    const approve = screen.getByRole("button", { name: "Approve" });
    approve.focus();
    expect(fireEvent.keyDown(actions, { key: "ArrowDown" })).toBe(true);
    expect(document.activeElement).toBe(approve);
  });
});

describe("the requested resource is the structured value the reply carried", () => {
  it("renders every member of the descriptor as a pair", () => {
    renderCard(
      pendingRecord({
        resourceDescriptor: { command: "git push --force origin main", branch: "main" },
      }),
    );
    const disclosure = screen.getByRole("button", { name: "What was asked for" });
    fireEvent.click(disclosure);
    expect(screen.getByText("command")).not.toBeNull();
    expect(screen.getByText("git push --force origin main")).not.toBeNull();
    expect(screen.getByText("branch")).not.toBeNull();
    // Negative control on the "no local formatter" rule: a string member renders
    // with no quotes added around it, so a JSON dump of the whole descriptor would
    // fail this assertion rather than pass it.
    expect(screen.queryByText(/^\{/u)).toBeNull();
  });

  it("renders a non-string member as its JSON form rather than dropping it", () => {
    renderCard(pendingRecord({ resourceDescriptor: { bytes: 4096, dryRun: false } }));
    fireEvent.click(screen.getByRole("button", { name: "What was asked for" }));
    expect(screen.getByText("4096")).not.toBeNull();
    expect(screen.getByText("false")).not.toBeNull();
  });

  it("says so when the descriptor carried no members at all", () => {
    renderCard(pendingRecord({ resourceDescriptor: {} }));
    fireEvent.click(screen.getByRole("button", { name: "What was asked for" }));
    expect(screen.getByText(/descriptor with nothing in it/u)).not.toBeNull();
  });
});

describe("the facts the reply requires", () => {
  it("names the run that raised the request", () => {
    renderCard(pendingRecord({ runId: "019b7a33-3300-740e-8110-d1a4c1150511" }));
    const facts = screen.getByText("Raised by run").closest("div");
    expect(facts).not.toBeNull();
    expect(
      within(facts ?? document.body).getByText("019b7a33-3300-740e-8110-d1a4c1150511"),
    ).not.toBeNull();
  });

  it("shows both instants as a clock reading that still carries the wire value", () => {
    renderCard(
      pendingRecord({
        createdAt: "2026-01-01T13:30:00.900Z",
        updatedAt: "2026-01-01T14:05:20.000Z",
      }),
    );
    // The formatted reading is what a person reads; the exact instant rides
    // `title`, because a formatted figure never hides the value the daemon sent.
    const created = screen.getByTitle("2026-01-01T13:30:00.900Z");
    const changed = screen.getByTitle("2026-01-01T14:05:20.000Z");
    expect(created.textContent).not.toBe("2026-01-01T13:30:00.900Z");
    expect(changed.textContent).not.toBe("");
  });
});

describe("a remembered scope on a resolved record", () => {
  it("names the boundary and the pattern it was narrowed to", () => {
    renderCard(
      pendingRecord({
        state: "approved",
        resolvedAt: "2026-01-01T13:30:00.420Z",
        decision: "approved",
        approverId: "participant-you",
        effectiveScope: "session",
        rememberedScope: { kind: "run", pattern: "packages/contracts/**" },
      }),
    );
    expect(screen.getByText("This run only")).not.toBeNull();
    expect(screen.getByText("packages/contracts/**")).not.toBeNull();
  });

  it("says the grant is category-wide when it carried no pattern", () => {
    renderCard(
      pendingRecord({
        state: "approved",
        resolvedAt: "2026-01-01T13:30:00.420Z",
        decision: "approved",
        approverId: "participant-you",
        effectiveScope: "session",
        rememberedScope: { kind: "session" },
      }),
    );
    expect(screen.getByText("the whole category inside that boundary")).not.toBeNull();
  });
});
