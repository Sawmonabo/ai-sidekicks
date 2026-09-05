// The roster: every row present, each in its own hue, none of them a control.

import type { PresenceReadResponseParticipant } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import { frozenStartMilliseconds } from "../frozen-start.test-support.js";
import { ParticipantHueAllocator } from "../../tokens/index.js";
import type { ChannelActivityLabels } from "../activity-model.js";
import { rosterRowsFrom, type RosterRow } from "./presence-model.js";
import type { PushDrivenReadState } from "../../seats/index.js";
import { Roster } from "./Roster.js";

const NOW_MILLISECONDS = frozenStartMilliseconds();

const LABELS: ChannelActivityLabels = {
  participantLabel: (participantId) => participantId.replace("participant-", ""),
  runLabel: (runId) => runId,
};

function participant(
  participantId: string,
  state: PresenceReadResponseParticipant["state"],
): PresenceReadResponseParticipant {
  return {
    participantId: participantId as PresenceReadResponseParticipant["participantId"],
    state,
    lastSeen: "2026-01-01T09:59:30.000Z",
  };
}

function renderRoster(
  participants: readonly PresenceReadResponseParticipant[],
  overrides?: {
    readonly allocator?: ParticipantHueAllocator;
    readonly selfParticipantId?: string;
    readonly composingChannelFor?: (participantId: string) => string | undefined;
    readonly isLastKnown?: boolean;
  },
): ReturnType<typeof render> {
  const allocator = overrides?.allocator ?? new ParticipantHueAllocator();
  const rows: readonly RosterRow[] = rosterRowsFrom(
    participants,
    (participantId) => allocator.assignmentFor(participantId),
    overrides?.selfParticipantId,
  );
  const state: PushDrivenReadState<readonly PresenceReadResponseParticipant[]> = {
    kind: "loaded",
    value: participants,
  };
  return render(
    <Roster
      state={state}
      rows={rows}
      nowMilliseconds={NOW_MILLISECONDS}
      labels={LABELS}
      composingChannelFor={overrides?.composingChannelFor ?? (() => undefined)}
      isLastKnown={overrides?.isLastKnown ?? false}
    />,
  );
}

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

  it("offers no control at all — roles and invites live elsewhere", () => {
    const { container } = renderRoster([participant("participant-one", "online")]);
    expect(container.querySelectorAll("button")).toHaveLength(0);
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
        isLastKnown={false}
      />,
    );
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
  });

  it("renders a presence refusal verbatim", () => {
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
        isLastKnown={false}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("presence.permission_denied");
    expect(text).toContain("Per-device detail is withheld.");
  });

  it("degrades under one line rather than per-row noise", () => {
    const { container } = renderRoster(
      [participant("participant-one", "online"), participant("participant-two", "idle")],
      { isLastKnown: true },
    );
    expect(container.querySelectorAll(".meridian-roster__degraded")).toHaveLength(1);
  });
});
