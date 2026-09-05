// What the channel list renders, and — as load-bearing — what it refuses to.

import type { ChannelListResponseChannel } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ManualClock, refuse } from "../../core/index.js";
import { ActivityIndicatorRegistry, type ChannelActivityLabels } from "../activity-model.js";
import { ChannelList } from "./ChannelList.js";
import type { PushDrivenReadState } from "../../seats/index.js";

const LABELS: ChannelActivityLabels = {
  participantLabel: (participantId) => participantId,
  runLabel: (runId) => runId,
};

function channel(
  id: string,
  state: ChannelListResponseChannel["state"],
  name: string,
): ChannelListResponseChannel {
  return {
    id: id as ChannelListResponseChannel["id"],
    name,
    state,
    participantCount: 4,
  };
}

function loaded(
  channels: readonly ChannelListResponseChannel[],
): PushDrivenReadState<readonly ChannelListResponseChannel[]> {
  return { kind: "loaded", value: channels };
}

function renderList(
  state: PushDrivenReadState<readonly ChannelListResponseChannel[]>,
  overrides?: { readonly openPane?: () => void; readonly isCatchingUp?: boolean },
): ReturnType<typeof render> {
  return render(
    <ChannelList
      state={state}
      openPane={overrides?.openPane ?? (() => undefined)}
      activity={new ActivityIndicatorRegistry(new ManualClock())}
      labels={LABELS}
      isCatchingUp={overrides?.isCatchingUp ?? false}
    />,
  );
}

describe("channel list — the rows", () => {
  it("renders every channel the daemon served, main first", () => {
    const { container } = renderList(
      loaded([
        channel("channel-review", "active", "review"),
        channel("channel-main", "active", "main"),
      ]),
    );
    const names = [...container.querySelectorAll(".meridian-channel-row__name")].map(
      (element) => element.textContent ?? "",
    );
    expect(names).toStrictEqual(["main", "review"]);
  });

  it("wears each state as a wire figure rather than as a word of its own", () => {
    const { container } = renderList(loaded([channel("channel-relay", "muted", "relay")]));
    expect(container.textContent ?? "").toContain("muted");
  });

  it("collapses archived channels behind one closed disclosure", () => {
    const { container } = renderList(
      loaded([
        channel("channel-main", "active", "main"),
        channel("channel-old", "archived", "old"),
      ]),
    );
    const disclosure = container.querySelector<HTMLDetailsElement>(".meridian-channels__archive");
    expect(disclosure).not.toBeNull();
    expect(disclosure?.open).toBe(false);
    expect(container.querySelectorAll(".meridian-channels__list")).toHaveLength(2);
  });

  it("negative control: with no archived channel the disclosure does not exist", () => {
    const { container } = renderList(loaded([channel("channel-main", "active", "main")]));
    expect(container.querySelector(".meridian-channels__archive")).toBeNull();
  });

  it("renders one row per archived channel however many the read carried", () => {
    // Thirteen — one past the twelve-row slice this list used to take. The slice
    // bounded the DATA while the summary above it kept counting the whole read, so
    // the thirteenth row was advertised and unreachable: no channel read carries a
    // cursor, so there was nothing to page to. The scroll box bounds the height.
    const archived = Array.from({ length: 13 }, (_unused, index) =>
      channel(`channel-old-${String(index)}`, "archived", `old-${String(index)}`),
    );
    const { container } = renderList(
      loaded([channel("channel-main", "active", "main"), ...archived]),
    );
    const archivedRows = container.querySelectorAll(
      ".meridian-channels__list--archived .meridian-channel-row",
    );
    expect(archivedRows).toHaveLength(13);
  });

  it("shows every row the archived summary counts", () => {
    // The clean assertion, stated as the equality the old slice broke: the summary
    // is derived from the same array the list renders, so the two can never
    // disagree. Pre-fix this read twelve rows against a summary saying thirteen.
    const archived = Array.from({ length: 13 }, (_unused, index) =>
      channel(`channel-old-${String(index)}`, "archived", `old-${String(index)}`),
    );
    const { container } = renderList(
      loaded([channel("channel-main", "active", "main"), ...archived]),
    );
    const summaryText =
      container.querySelector(".meridian-channels__archive-summary")?.textContent ?? "";
    const renderedArchivedRowCount = container.querySelectorAll(
      ".meridian-channels__list--archived .meridian-channel-row",
    ).length;
    expect(summaryText).toContain(`${String(renderedArchivedRowCount)} archived channels`);
  });

  it("negative control: a small archived set still renders exactly what it was served", () => {
    const { container } = renderList(
      loaded([
        channel("channel-main", "active", "main"),
        channel("channel-old", "archived", "old"),
      ]),
    );
    expect(
      container.querySelectorAll(".meridian-channels__list--archived .meridian-channel-row"),
    ).toHaveLength(1);
    expect(
      container.querySelector(".meridian-channels__archive-summary")?.textContent ?? "",
    ).toContain("1 archived channel");
  });
});

describe("channel list — what it offers", () => {
  it("opens the channel through the registered pane kind and entity kind", () => {
    const openPane = vi.fn();
    const { container } = renderList(loaded([channel("channel-main", "active", "main")]), {
      openPane,
    });
    container.querySelector<HTMLButtonElement>(".meridian-channel-row__open")?.click();
    expect(openPane).toHaveBeenCalledWith({
      kind: "timeline",
      entity: { kind: "channel", id: "channel-main" },
    });
  });

  it("makes the whole row one keyboard-reachable control", () => {
    const { container } = renderList(loaded([channel("channel-main", "active", "main")]));
    const controls = container.querySelectorAll("button");
    expect(controls).toHaveLength(1);
    expect(controls[0]?.getAttribute("type")).toBe("button");
  });

  it("offers no mute, unmute, or archive control, because no verb exists behind one", () => {
    // Counted rather than word-matched: a row WEARS its state, so "muted" and
    // "archived" are legitimately on screen. What must not exist is a second control
    // beside the open one — so the assertion is that every button in the list is a
    // row's own open control and there are exactly as many as there are rows.
    const { container } = renderList(
      loaded([
        channel("channel-main", "active", "main"),
        channel("channel-relay", "muted", "relay"),
        channel("channel-old", "archived", "old"),
      ]),
    );
    const controls = [...container.querySelectorAll("button")];
    expect(controls).toHaveLength(3);
    expect(
      controls.every((element) => element.classList.contains("meridian-channel-row__open")),
    ).toBe(true);
  });

  it("negative control: the state a row wears is a label and not a control", () => {
    const { container } = renderList(loaded([channel("channel-relay", "muted", "relay")]));
    expect(container.textContent ?? "").toContain("muted");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("shows no count of rows it was not served", () => {
    // The non-disclosure filter is the daemon's, and a "N more you cannot see" line
    // would leak exactly what the omission protects.
    const { container } = renderList(loaded([channel("channel-main", "active", "main")]));
    const text = (container.textContent ?? "").toLowerCase();
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("cannot see");
  });
});

describe("channel list — the absences", () => {
  it("says the read is in flight rather than showing an empty list", () => {
    const { container } = renderList({ kind: "not-loaded" });
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
  });

  it("renders the daemon's refusal verbatim, code and message", () => {
    const { container } = renderList({
      kind: "failed",
      refusal: refuse("daemon", "channel.not_found", "That channel is gone."),
    });
    const text = container.textContent ?? "";
    expect(text).toContain("channel.not_found");
    expect(text).toContain("That channel is gone.");
  });

  it("teaches what a channel is for when there is none to show", () => {
    const { container } = renderList(loaded([]));
    expect(container.textContent ?? "").toContain("a room of one topic");
  });

  it("says the projection is catching up without marking individual rows", () => {
    const { container } = renderList(loaded([channel("channel-main", "active", "main")]), {
      isCatchingUp: true,
    });
    expect(container.querySelectorAll(".meridian-channels__degraded")).toHaveLength(1);
  });

  it("negative control: a healthy projection renders no catching-up line", () => {
    const { container } = renderList(loaded([channel("channel-main", "active", "main")]));
    expect(container.querySelector(".meridian-channels__degraded")).toBeNull();
  });
});
