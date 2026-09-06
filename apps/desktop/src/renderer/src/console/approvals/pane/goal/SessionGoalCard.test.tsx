// The goal card: no control without a role, no optimism, and clearing is its own act.
//
// Three of the five rules are only checkable here, because each is the ABSENCE of
// something a card like this usually has — a control offered to everyone, a text
// field that keeps showing what you typed after you sent it, and a single control
// whose empty value means "clear".

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SessionGoalCard } from "./SessionGoalCard.js";
import { ACCENT_FILL_CLASS } from "../../../primitives/index.js";
import { refuse, type ConsoleRefusal } from "../../../core/index.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { createFixture } from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { type SessionGoalProjection } from "../../../bridge/index.js";

// The revisions below stand for whatever entry the fold read each projection from.
// The card compares them and never parses them, so what they say does not matter and
// whether two of them are the same does.
const NO_GOAL: SessionGoalProjection = { status: "none", revision: "unset" };
const A_GOAL: SessionGoalProjection = {
  status: "set",
  text: "Ship the approvals pane",
  revision: "o:1:node-alpha",
};

const FIRST_SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55b5";
const SECOND_SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55b6";

/**
 * A bridge this card only ever compares by identity.
 *
 * The card reads no member of it — the subject the editor is held under is the pair
 * `(bridge, sessionId)` and the comparison is `===` — and a fresh fixture per call is
 * what makes the identity cases mean anything: two of them stand for a replaced
 * window transport, which is the same shape the console really hands the card.
 *
 * The shipped fixture rather than an empty object cast to the type, because "reads no
 * member of it" is the claim under test rather than a licence: a card that started
 * reading one would get a real answer and be caught by what it renders, where a cast
 * stand-in fails on `undefined` somewhere that names neither the read nor the card.
 */
function inertBridge(): ConsoleBridge {
  return createFixture().bridge;
}

function renderCard(
  overrides: {
    goal?: SessionGoalProjection;
    canMutate?: boolean | undefined;
    authorizationRefusal?: ConsoleRefusal;
    isMutating?: boolean;
    onUpdate?: (text: string) => void;
    onClear?: () => void;
    bridge?: ConsoleBridge;
    sessionId?: string;
  } = {},
): {
  rerender: (goal: SessionGoalProjection) => void;
  /** Rebind the mounted card to another subject, as a pane rebind does. */
  rebindTo: (subject: { bridge?: ConsoleBridge; sessionId?: string }) => void;
} {
  const props = {
    bridge: overrides.bridge ?? inertBridge(),
    sessionId: overrides.sessionId ?? FIRST_SESSION_ID,
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
    rebindTo: (subject) => {
      view.rerender(
        <SessionGoalCard
          {...props}
          bridge={subject.bridge ?? props.bridge}
          sessionId={subject.sessionId ?? props.sessionId}
        />,
      );
    },
  };
}

/**
 * A delivery refusal carrying the failed bindings the wire named.
 *
 * Built by spread rather than through the extension writer, which the core door does
 * not publish: the readers work structurally off the value, so this is the same shape
 * a rebuilt wire rejection produces — which is the point, since that rebuild is the
 * only producer of one in the running console.
 */
function deliveryRefusalNaming(failedBindingIds: readonly string[]): ConsoleRefusal {
  const refusal: ConsoleRefusal & Record<string, unknown> = {
    ...refuse("session-goal", "session.goal_delivery_failed", "Delivery failed."),
    failedBindingIds,
  };
  return refusal;
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
    expect(screen.getByText("This goal cannot be sent as written.")).not.toBeNull();
  });

  it("negative control: valid text enables the save and carries no complaint", () => {
    renderCard({ goal: A_GOAL });
    fireEvent.click(screen.getByRole("button", { name: "Change goal" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Something sendable" } });
    expect((screen.getByRole("button", { name: "Save goal" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.queryByText("This goal cannot be sent as written.")).toBeNull();
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
