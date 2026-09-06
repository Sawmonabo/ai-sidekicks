// The roster: every row present, each in its own hue, none of them a control.
//
// The READ is this file's subject — the four wire states, the absences, the refusals,
// and the work a re-render that moved nothing does. What a LOADED row then MARKS —
// the role, the terminal-lease holder, the device fan-out behind it — is
// `Roster.marks.test.tsx`, and the scaffolding both drive the component through is
// `Roster.test-support.tsx`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import { ParticipantHueAllocator } from "../../tokens/index.js";
import { rosterRowsFrom, type PresenceReading, type RosterRow } from "./presence-model.js";
import type { PushDrivenReadState } from "../../seats/index.js";
import { Roster } from "./Roster.js";
import {
  LABELS,
  NOW_MILLISECONDS,
  NO_REOPEN,
  READ_PROPS,
  participant,
  renderRoster,
} from "./Roster.test-support.js";

describe("roster — every row stays", () => {
  it("keeps an offline participant in the list and marks them", () => {
    const { container } = renderRoster([
      participant("participant-one", "online"),
      participant("participant-two", "offline"),
    ]);
    expect(container.querySelectorAll(".meridian-roster-row")).toHaveLength(2);
    expect(container.querySelectorAll(".meridian-roster-row--offline")).toHaveLength(1);
    expect(container.textContent ?? "").toContain("offline");
  });

  it("renders the wire's four states and derives no fifth", () => {
    const { container } = renderRoster([
      participant("participant-one", "online"),
      participant("participant-two", "idle"),
      participant("participant-three", "reconnecting"),
      participant("participant-four", "offline"),
    ]);
    const states = [...container.querySelectorAll(".meridian-chip__label")].map(
      (element) => element.textContent ?? "",
    );
    expect(states).toStrictEqual(["online", "idle", "reconnecting", "offline"]);
  });

  it("spends amber on reconnecting alone, because that is the state a person may act on", () => {
    const { container } = renderRoster([
      participant("participant-one", "online"),
      participant("participant-two", "reconnecting"),
    ]);
    expect(container.querySelectorAll(".meridian-chip--attention")).toHaveLength(1);
  });

  it("negative control: an all-online roster spends no attention colour", () => {
    const { container } = renderRoster([
      participant("participant-one", "online"),
      participant("participant-two", "online"),
    ]);
    expect(container.querySelectorAll(".meridian-chip--attention")).toHaveLength(0);
  });
});

describe("roster — identity", () => {
  it("carries each participant's wheel hue on the row's own mark", () => {
    const allocator = new ParticipantHueAllocator();
    const assignment = allocator.admit("participant-one");
    const { container } = renderRoster([participant("participant-one", "online")], { allocator });
    const mark = container.querySelector<HTMLElement>(".meridian-roster-row__mark");
    expect(mark?.style.getPropertyValue("--meridian-roster-hue")).toContain(
      String(assignment.step).padStart(2, "0"),
    );
  });

  it("renders a participant the wheel has not admitted on the neutral boundary", () => {
    const { container } = renderRoster([participant("participant-stranger", "online")]);
    const mark = container.querySelector<HTMLElement>(".meridian-roster-row__mark");
    expect(mark?.style.getPropertyValue("--meridian-roster-hue")).toContain("edge-strong");
  });

  it("marks the reader without moving their row", () => {
    const { container } = renderRoster(
      [participant("participant-other", "online"), participant("participant-me", "offline")],
      { selfParticipantId: "participant-me" },
    );
    const rows = [...container.querySelectorAll(".meridian-roster-row")];
    expect(rows[1]?.classList.contains("meridian-roster-row--self")).toBe(true);
    expect(rows[0]?.classList.contains("meridian-roster-row--self")).toBe(false);
  });
});

describe("roster — composing, and what the surface never offers", () => {
  it("shows the channel a person is composing in beside their row", () => {
    const { container } = renderRoster([participant("participant-one", "online")], {
      composingChannelFor: (participantId) =>
        participantId === "participant-one" ? "channel-main" : undefined,
    });
    expect(container.querySelector(".meridian-roster-row__composing")).not.toBeNull();
    expect(container.textContent ?? "").toContain("channel-main");
  });

  it("negative control: with nobody composing the indicator is absent, not blank", () => {
    const { container } = renderRoster([participant("participant-one", "online")]);
    expect(container.querySelector(".meridian-roster-row__composing")).toBeNull();
  });

  it("offers no control on the session — roles and invites live elsewhere", () => {
    // Every button this surface draws acts on a READ: the device disclosure here, and
    // the re-open on the failed arm. A control that acted on the SESSION — a role
    // change, an invite, a lease claim — would be a second place to perform something
    // that already has one, so the assertion counts the session controls at zero
    // rather than counting buttons at zero and going stale the first time a read grew
    // an affordance.
    const { container } = renderRoster([participant("participant-one", "online")]);
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.className).toContain("meridian-roster-row__detail-toggle");
  });
});

describe("roster — the absences", () => {
  it("says the read is in flight rather than showing nobody", () => {
    const { container } = render(
      <Roster
        state={{ kind: "not-loaded" }}
        rows={[]}
        nowMilliseconds={NOW_MILLISECONDS}
        labels={LABELS}
        composingChannelFor={() => undefined}
        {...READ_PROPS}
        isLastKnown={false}
        onReopen={() => undefined}
      />,
    );
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
  });

  it("renders a presence refusal verbatim", () => {
    const { container } = render(
      <Roster
        state={{
          kind: "failed",
          refusal: refuse("daemon", "presence.unavailable", "The presence service is down."),
        }}
        rows={[]}
        nowMilliseconds={NOW_MILLISECONDS}
        labels={LABELS}
        composingChannelFor={() => undefined}
        {...READ_PROPS}
        isLastKnown={false}
        onReopen={() => undefined}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("presence.unavailable");
    expect(text).toContain("The presence service is down.");
  });

  it("renders the authorization answer as the summary rather than as an error", () => {
    // `Spec-018` makes the aggregated summary the unauthorized-DEFAULT projection, so
    // this code is an answer and not a failure. A refusal card would put an error tone
    // on a correct reading, and its retry would offer to ask a question whose answer is
    // settled by who the caller is.
    const { container } = render(
      <Roster
        state={{
          kind: "failed",
          refusal: refuse("daemon", "presence.permission_denied", "Per-device detail is withheld."),
        }}
        rows={[]}
        nowMilliseconds={NOW_MILLISECONDS}
        labels={LABELS}
        composingChannelFor={() => undefined}
        {...READ_PROPS}
        isLastKnown={false}
        onReopen={() => undefined}
      />,
    );
    expect(container.querySelector(".meridian-refusal__action")).toBeNull();
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.textContent ?? "").toContain("aggregated summary");
  });

  it("offers a way back into a stream that refused to open", () => {
    // A refused subscribe is terminal for the read: nothing re-runs the effect that
    // opened it, so without a control the column says one line of error text for the
    // life of the window and a cap that clears in thirty seconds is indistinguishable
    // from a permanent refusal.
    let reopenCount = 0;
    const { container } = render(
      <Roster
        state={{
          kind: "failed",
          refusal: refuse("daemon", "ratelimit.exceeded", "Too many open subscriptions."),
        }}
        rows={[]}
        nowMilliseconds={NOW_MILLISECONDS}
        labels={LABELS}
        composingChannelFor={() => undefined}
        {...READ_PROPS}
        isLastKnown={false}
        onReopen={() => {
          reopenCount += 1;
        }}
      />,
    );
    const retry = container.querySelector(".meridian-refusal__action button");
    expect(retry?.textContent).toBe("Try again");
    (retry as HTMLButtonElement).click();
    expect(reopenCount).toBe(1);
  });

  it("negative control: a loaded roster offers no re-open", () => {
    // Without this, the case above would pass over a column that offered the control
    // on every arm — a retry beside a list that is already current, which reads as a
    // refresh the console does not have.
    const { container } = renderRoster([participant("participant-one", "online")]);
    expect(container.querySelector(".meridian-refusal__action")).toBeNull();
  });

  it("degrades under one line rather than per-row noise", () => {
    const { container } = renderRoster(
      [participant("participant-one", "online"), participant("participant-two", "idle")],
      { isLastKnown: true },
    );
    expect(container.querySelectorAll(".meridian-roster__degraded")).toHaveLength(1);
  });
});

describe("roster — a re-render that moved nothing does no work", () => {
  it("skips the list when a parent re-renders with the same props", () => {
    // Counts the roster's OWN work rather than a render count: `composingChannelFor`
    // is called once per row per pass, so the count is the number of rows the list
    // actually re-derived. The sidebar re-renders whenever any of its sections moves,
    // and this list is one of the console's longest.
    let lookupCallCount = 0;
    const composingChannelFor = (): string | undefined => {
      lookupCallCount += 1;
      return undefined;
    };
    const rows: readonly RosterRow[] = rosterRowsFrom(
      [participant("participant-one", "online"), participant("participant-two", "idle")],
      (participantId) => new ParticipantHueAllocator().assignmentFor(participantId),
      undefined,
    );
    const state: PushDrivenReadState<PresenceReading> = {
      kind: "loaded",
      value: { participants: [], readAtMilliseconds: NOW_MILLISECONDS },
    };
    // A FRESH element each pass, holding the same props. Handing the same element
    // back would bail out on identity alone and assert nothing about this component.
    const rosterElement = (): React.JSX.Element => (
      <Roster
        state={state}
        rows={rows}
        nowMilliseconds={NOW_MILLISECONDS}
        labels={LABELS}
        composingChannelFor={composingChannelFor}
        {...READ_PROPS}
        isLastKnown={false}
        onReopen={NO_REOPEN}
      />
    );
    const { rerender } = render(<div>{rosterElement()}</div>);
    expect(lookupCallCount).toBe(2);

    rerender(<div>{rosterElement()}</div>);
    expect(lookupCallCount).toBe(2);
  });

  it("negative control: a moved instant re-renders every row", () => {
    // Without this, the case above would pass over a roster that never re-rendered at
    // all — which is a list whose ages freeze at the instant it first mounted.
    let lookupCallCount = 0;
    const composingChannelFor = (): string | undefined => {
      lookupCallCount += 1;
      return undefined;
    };
    const rows: readonly RosterRow[] = rosterRowsFrom(
      [participant("participant-one", "online"), participant("participant-two", "idle")],
      (participantId) => new ParticipantHueAllocator().assignmentFor(participantId),
      undefined,
    );
    const state: PushDrivenReadState<PresenceReading> = {
      kind: "loaded",
      value: { participants: [], readAtMilliseconds: NOW_MILLISECONDS },
    };
    const rosterAt = (nowMilliseconds: number): React.JSX.Element => (
      <Roster
        state={state}
        rows={rows}
        nowMilliseconds={nowMilliseconds}
        labels={LABELS}
        composingChannelFor={composingChannelFor}
        {...READ_PROPS}
        isLastKnown={false}
        onReopen={NO_REOPEN}
      />
    );
    const { rerender } = render(<div>{rosterAt(NOW_MILLISECONDS)}</div>);
    expect(lookupCallCount).toBe(2);

    rerender(<div>{rosterAt(NOW_MILLISECONDS + 60_000)}</div>);
    expect(lookupCallCount).toBe(4);
  });
});
