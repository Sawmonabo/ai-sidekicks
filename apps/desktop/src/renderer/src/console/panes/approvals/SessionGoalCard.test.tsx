// The goal card: no control without a role, no optimism, and clearing is its own act.
//
// Three of the five rules are only checkable here, because each is the ABSENCE of
// something a card like this usually has — a control offered to everyone, a text
// field that keeps showing what you typed after you sent it, and a single control
// whose empty value means "clear".

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SessionGoalCard } from "./SessionGoalCard.js";
import { ACCENT_FILL_CLASS } from "../../primitives/index.js";
import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { type SessionGoalProjection } from "./session-goal.js";

// The revisions below stand for whatever entry the fold read each projection from.
// The card compares them and never parses them, so what they say does not matter and
// whether two of them are the same does.
const NO_GOAL: SessionGoalProjection = { status: "none", revision: "unset" };
const A_GOAL: SessionGoalProjection = {
  status: "set",
  text: "Ship the approvals pane",
  revision: "o:1:node-alpha",
};

function renderCard(
  overrides: {
    goal?: SessionGoalProjection;
    canMutate?: boolean | undefined;
    authorizationRefusal?: ConsoleRefusal;
    isMutating?: boolean;
    onUpdate?: (text: string) => void;
    onClear?: () => void;
  } = {},
): { rerender: (goal: SessionGoalProjection) => void } {
  const props = {
    goal: overrides.goal ?? NO_GOAL,
    canMutate: "canMutate" in overrides ? overrides.canMutate : true,
    authorizationRefusal: overrides.authorizationRefusal,
    isMutating: overrides.isMutating ?? false,
    refusal: undefined,
    onUpdate: overrides.onUpdate ?? vi.fn(),
    onClear: overrides.onClear ?? vi.fn(),
  };
  const view = render(<SessionGoalCard {...props} />);
  return {
    rerender: (goal) => {
      view.rerender(<SessionGoalCard {...props} goal={goal} />);
    },
  };
}

describe("eligibility is supplied, never derived", () => {
  it("offers no control at all when the role has not been read", () => {
    renderCard({ canMutate: undefined });
    expect(screen.queryByRole("button")).toBeNull();
    // The reading is still there — a read-only participant sees the goal, they
    // just cannot change it.
    expect(screen.getByText("No goal set")).not.toBeNull();
  });

  it("offers no control to a role that may not mutate", () => {
    renderCard({ canMutate: false, goal: A_GOAL });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Ship the approvals pane")).not.toBeNull();
  });

  it("negative control: a role that may mutate is offered one", () => {
    renderCard({ canMutate: true, goal: A_GOAL });
    expect(screen.getByRole("button", { name: "Change goal" })).not.toBeNull();
  });
});

describe("setting and clearing are two acts", () => {
  it("names the act after the current state, and prefills from the log", () => {
    renderCard({ goal: A_GOAL });
    fireEvent.click(screen.getByRole("button", { name: "Change goal" }));
    const field = screen.getByRole("textbox");
    expect((field as HTMLTextAreaElement).value).toBe("Ship the approvals pane");
  });

  it("keeps the clear action inside the editor and never beside the reading", () => {
    renderCard({ goal: A_GOAL });
    expect(screen.queryByRole("button", { name: "Clear the goal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change goal" }));
    expect(screen.getByRole("button", { name: "Clear the goal" })).not.toBeNull();
  });

  it("cannot clear a goal that is not set", () => {
    renderCard({ goal: NO_GOAL });
    fireEvent.click(screen.getByRole("button", { name: "Set a goal" }));
    const clear = screen.getByRole("button", { name: "Clear the goal" });
    expect((clear as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends the typed text on save, and calls the clear operation on clear", () => {
    const onUpdate = vi.fn();
    const onClear = vi.fn();
    renderCard({ goal: A_GOAL, onUpdate, onClear });
    fireEvent.click(screen.getByRole("button", { name: "Change goal" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A different goal" } });
    fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
    expect(onUpdate.mock.calls).toStrictEqual([["A different goal"]]);
    fireEvent.click(screen.getByRole("button", { name: "Clear the goal" }));
    expect(onClear).toHaveBeenCalledTimes(1);
    // Two operations, two handlers — a clear never travels as an empty update.
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("one primary action per surface", () => {
  it("gives the save the filled accent and leaves every sibling quiet", () => {
    renderCard({ goal: A_GOAL });
    fireEvent.click(screen.getByRole("button", { name: "Change goal" }));

    // The face comes from the primitives rather than from this pane's sheet, which
    // is what makes the ink measurable: `tokens/contrast.test.ts` measures
    // `accent-ink` against the fill, and a control painting its own accent is a
    // pairing that measurement never sees.
    expect(screen.getByRole("button", { name: "Save goal" }).classList).toContain(
      ACCENT_FILL_CLASS,
    );

    // The negative control, and rule 1 itself: exactly one control in the editor
    // carries the accent, so a sibling wearing it is a second primary action.
    for (const quiet of ["Clear the goal", "Cancel"]) {
      expect(screen.getByRole("button", { name: quiet }).classList).not.toContain(
        ACCENT_FILL_CLASS,
      );
    }
  });
});

describe("the field refuses on the daemon's own rule", () => {
  it("will not send blank text, and says why", () => {
    const onUpdate = vi.fn();
    renderCard({ goal: A_GOAL, onUpdate });
    fireEvent.click(screen.getByRole("button", { name: "Change goal" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    const save = screen.getByRole("button", { name: "Save goal" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByText("A goal cannot be blank.")).not.toBeNull();
  });

  it("negative control: valid text enables the save and carries no complaint", () => {
    renderCard({ goal: A_GOAL });
    fireEvent.click(screen.getByRole("button", { name: "Change goal" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Something sendable" } });
    expect((screen.getByRole("button", { name: "Save goal" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.queryByText("A goal cannot be blank.")).toBeNull();
  });
});

describe("nothing is optimistic", () => {
  it("closes the editor when the log moves, not when a reply lands", () => {
    const view = renderCard({ goal: NO_GOAL });
    fireEvent.click(screen.getByRole("button", { name: "Set a goal" }));
    expect(screen.getByRole("textbox")).not.toBeNull();
    // The editor is still open across a re-render that did NOT move the fold: a
    // reply is not a commit, and closing here would show text the log lacks.
    view.rerender(NO_GOAL);
    expect(screen.queryByRole("textbox")).not.toBeNull();
    view.rerender(A_GOAL);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Ship the approvals pane")).not.toBeNull();
  });

  it("keeps the editor and the draft across an event that did not touch the goal", () => {
    // The fold runs over the whole timeline and answers with a fresh object on every
    // beat, so a `usage.*` reading or a run transition arriving mid-edit used to
    // close this editor and throw away what the participant had typed. Same
    // revision, different object: the goal did not move, and neither does this.
    const view = renderCard({ goal: A_GOAL });
    fireEvent.click(screen.getByRole("button", { name: "Change goal" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Half a sentence" } });
    view.rerender({ ...A_GOAL });
    const field = screen.getByRole("textbox");
    expect((field as HTMLTextAreaElement).value).toBe("Half a sentence");
  });

  it("closes the editor when the goal is re-set to the text it already had", () => {
    // A new revision carrying the same words is a participant's act, not a no-op,
    // and a card that compared TEXT would leave the editor open over it.
    const view = renderCard({ goal: A_GOAL });
    fireEvent.click(screen.getByRole("button", { name: "Change goal" }));
    view.rerender({ ...A_GOAL, revision: "o:2:node-alpha" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("closes the editor when the goal is cleared", () => {
    const view = renderCard({ goal: A_GOAL });
    fireEvent.click(screen.getByRole("button", { name: "Change goal" }));
    view.rerender({ status: "none", revision: "o:3:node-alpha" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("No goal set")).not.toBeNull();
  });

  it("negative control: an unchanged revision on a fresh object is still a change of object", () => {
    // Without this, a card that had simply stopped closing on anything would pass
    // the case above. The object really is new on each of these re-renders, which is
    // what the old identity-keyed effect was reacting to.
    const view = renderCard({ goal: A_GOAL });
    fireEvent.click(screen.getByRole("button", { name: "Change goal" }));
    const first = { ...A_GOAL };
    const second = { ...A_GOAL };
    expect(second).not.toBe(first);
    view.rerender(first);
    view.rerender(second);
    expect(screen.queryByRole("textbox")).not.toBeNull();
  });

  it("says the change is settling while it is in flight", () => {
    renderCard({ goal: A_GOAL, isMutating: true });
    expect(screen.getByText("The goal change is settling.")).not.toBeNull();
  });

  it("states the turn boundary rather than implying it", () => {
    renderCard({ goal: A_GOAL });
    fireEvent.click(screen.getByRole("button", { name: "Change goal" }));
    expect(screen.getByText(/next turn boundary/u)).not.toBeNull();
    expect(screen.getByText(/remote leg may run a turn under the previous goal/u)).not.toBeNull();
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
