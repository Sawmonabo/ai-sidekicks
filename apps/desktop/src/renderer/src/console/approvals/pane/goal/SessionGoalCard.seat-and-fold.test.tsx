// Which subject the editor's draft belongs to, and what the fold says when the
// reading is not a goal.
//
// Split from `SessionGoalCard.test.tsx`, which owns the card's five rules. These two
// subjects are about state that outlives one render — the seat the draft is held
// under, and a projection that carries no goal at all — and both are asserted
// against the same mount, which lives in `session-goal-card.test-support.tsx`.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SessionGoalCard } from "./SessionGoalCard.js";
import { refuse } from "../../../core/index.js";
import {
  A_GOAL,
  FIRST_SESSION_ID,
  NO_GOAL,
  SECOND_SESSION_ID,
  deliveryRefusalNaming,
  inertBridge,
  renderCard,
} from "./session-goal-card.test-support.js";

describe("the editor belongs to the session it was opened for", () => {
  it("closes the editor and drops the draft when the card is rebound to another session", () => {
    // The finding: the reset watched only the goal revision, and every session with
    // no goal reads the same `"unset"` one — so the open editor and the half-typed
    // text survived the rebind and Save dispatched them through the new session's
    // own `onUpdate`. The two projections here are the SAME object, which is what
    // makes the revision identical rather than merely similar.
    const onUpdate = vi.fn();
    const driven = renderCard({ goal: NO_GOAL, sessionId: FIRST_SESSION_ID, onUpdate });
    fireEvent.click(screen.getByRole("button", { name: "Set a goal" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Half a sentence" } });

    driven.rebindTo({ sessionId: SECOND_SESSION_ID });

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save goal" })).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("opens the second session's editor empty rather than on the first one's draft", () => {
    // The other half: closing is not enough if the text is still held. Re-opening
    // under the new session has to meet an empty field, because a draft written for
    // one session is not an offer to send it to another.
    const driven = renderCard({ goal: NO_GOAL, sessionId: FIRST_SESSION_ID });
    fireEvent.click(screen.getByRole("button", { name: "Set a goal" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Half a sentence" } });

    driven.rebindTo({ sessionId: SECOND_SESSION_ID });
    fireEvent.click(screen.getByRole("button", { name: "Set a goal" }));

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("closes the editor when the window's bridge is replaced under one session", () => {
    // The subject is the pair. A replaced transport is a different subject even
    // where the session id is character-for-character the one before it.
    const driven = renderCard({ goal: NO_GOAL, sessionId: FIRST_SESSION_ID });
    fireEvent.click(screen.getByRole("button", { name: "Set a goal" }));

    driven.rebindTo({ bridge: inertBridge() });

    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("negative control: the same session and the same revision keep the editor open", () => {
    // Without this, a card that had simply stopped keeping the editor open at all
    // would pass every case above. It is also the rule the rebind must not be read
    // as contradicting: a re-render that moved neither subject nor log changes
    // nothing about what somebody is typing.
    const driven = renderCard({ goal: NO_GOAL, sessionId: FIRST_SESSION_ID });
    fireEvent.click(screen.getByRole("button", { name: "Set a goal" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Half a sentence" } });

    driven.rebindTo({ sessionId: FIRST_SESSION_ID });

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Half a sentence");
  });
});

describe("the readings that are not a goal", () => {
  it("says no goal is set rather than showing an empty line", () => {
    renderCard({ goal: NO_GOAL });
    expect(screen.getByText("No goal set")).not.toBeNull();
  });

  it("says the latest goal event could not be read", () => {
    renderCard({ goal: { status: "unreadable", revision: "e:event-nine" } });
    expect(screen.getByText("The latest goal event could not be read.")).not.toBeNull();
  });

  it("renders a refusal beside the card", () => {
    render(
      <SessionGoalCard
        bridge={inertBridge()}
        sessionId={FIRST_SESSION_ID}
        goal={A_GOAL}
        canMutate
        authorizationRefusal={undefined}
        isMutating={false}
        refusal={refuse("session-goal", "goal_mutation_in_flight", "A goal change is settling.")}
        onUpdate={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText("goal_mutation_in_flight")).not.toBeNull();
  });

  it("names the bindings a goal delivery failed on, beside the move", () => {
    // `error-contracts.md` puts `failedBindingIds` on the refusal's own
    // `data.fields`, and this is the only surface that can say which they were —
    // the shared table knows the code but not who did not answer.
    render(
      <SessionGoalCard
        bridge={inertBridge()}
        sessionId={FIRST_SESSION_ID}
        goal={A_GOAL}
        canMutate
        authorizationRefusal={undefined}
        isMutating={false}
        refusal={deliveryRefusalNaming(["binding-a", "binding-b"])}
        onUpdate={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByText("session.goal_delivery_failed")).not.toBeNull();
    expect(screen.getByText(/the goal did not change/)).not.toBeNull();
    expect(screen.getByText("binding-a")).not.toBeNull();
    expect(screen.getByText("binding-b")).not.toBeNull();
  });

  it("negative control: a refusal carrying no bindings names none", () => {
    // Without this, a card that rendered an empty binding row on every refusal
    // would pass the case above while claiming a failed binding that has no name.
    render(
      <SessionGoalCard
        bridge={inertBridge()}
        sessionId={FIRST_SESSION_ID}
        goal={A_GOAL}
        canMutate
        authorizationRefusal={undefined}
        isMutating={false}
        refusal={refuse("session-goal", "session.goal_delivery_failed", "Delivery failed.")}
        onUpdate={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByText(/the goal did not change/)).not.toBeNull();
    expect(document.querySelector(".meridian-goal__failed-bindings")).toBeNull();
  });

  it("says why no control is offered when the role read itself refused", () => {
    // The missing control and the reason it is missing are one surface: a person
    // who holds the role sees the code that says the console could not check it,
    // rather than a card that looks read-only for no stated reason.
    renderCard({
      canMutate: undefined,
      authorizationRefusal: refuse(
        "growth-port",
        "wire-unregistered",
        "This build cannot read which participant this window is.",
      ),
    });
    expect(screen.getByText("wire-unregistered")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("negative control: an unknown role with nothing refused says nothing", () => {
    // Without this, a card that rendered a standing "role unknown" notice would
    // pass the case above while claiming a refusal on every ordinary mount.
    renderCard({ canMutate: undefined });
    expect(screen.queryByText("wire-unregistered")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
