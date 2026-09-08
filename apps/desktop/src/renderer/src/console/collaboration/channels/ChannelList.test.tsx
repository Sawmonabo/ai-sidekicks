// What the channel list renders, and — as load-bearing — what it refuses to.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../../core/index.js";
import {
  CHANNEL_MAIN,
  CHANNEL_OLD,
  CHANNEL_RELAY,
  CHANNEL_REVIEW,
  channel,
  loaded,
  mainChannel,
  renderChannelListSettled,
} from "./channels.test-support.js";

describe("channel list — the rows", () => {
  it("renders every channel the daemon served, main first", async () => {
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review"), mainChannel()]),
    );
    const names = [...container.querySelectorAll(".meridian-channel-row__name")].map(
      (element) => element.textContent ?? "",
    );
    expect(names).toStrictEqual([MAIN_CHANNEL_NAME, "review"]);
  });

  it("wears each state as a wire figure rather than as a word of its own", async () => {
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_RELAY, "muted", "relay")]),
    );
    expect(container.textContent ?? "").toContain("muted");
  });

  it("wears an unnamed channel's own identifier, because that is what it has", async () => {
    // `name` is optional on the wire and its omission is the signal for a channel with
    // no friendly label — a `direct` one, in practice. The row shows the id rather
    // than a blank, because a row with no label is a row nobody can name.
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_RELAY, "active")]),
    );
    expect(container.querySelector(".meridian-channel-row__name")?.textContent).toBe(CHANNEL_RELAY);
  });

  it("keeps the member count one hover away rather than beside the name", async () => {
    // Three figures of equal weight is a row nobody scans. Name, audience and state
    // decide whether a person opens it; the count is on the row's own control.
    const { container } = await renderChannelListSettled(loaded([mainChannel()]));
    const open = container.querySelector<HTMLButtonElement>(".meridian-channel-row__open");
    expect(open?.title).toBe("4 members");
    expect(open?.textContent ?? "").not.toContain("4 members");
  });

  it("collapses archived channels behind one closed disclosure", async () => {
    const { container } = await renderChannelListSettled(
      loaded([mainChannel(), channel(CHANNEL_OLD, "archived", "old")]),
    );
    const disclosure = container.querySelector<HTMLDetailsElement>(".meridian-channels__archive");
    expect(disclosure).not.toBeNull();
    expect(disclosure?.open).toBe(false);
    expect(container.querySelectorAll(".meridian-channels__list")).toHaveLength(2);
  });

  it("negative control: with no archived channel the disclosure does not exist", async () => {
    const { container } = await renderChannelListSettled(loaded([mainChannel()]));
    expect(container.querySelector(".meridian-channels__archive")).toBeNull();
  });

  it("renders one row per archived channel however many the read carried", async () => {
    // Thirteen — one past the twelve-row slice this list used to take. The slice
    // bounded the DATA while the summary above it kept counting the whole read, so
    // the thirteenth row was advertised and unreachable: no channel read carries a
    // cursor, so there was nothing to page to. The scroll box bounds the height.
    const archived = Array.from({ length: 13 }, (_unused, index) =>
      channel(`${CHANNEL_OLD}-${String(index)}`, "archived", `old-${String(index)}`),
    );
    const { container } = await renderChannelListSettled(loaded([mainChannel(), ...archived]));
    const archivedRows = container.querySelectorAll(
      ".meridian-channels__list--archived .meridian-channel-row",
    );
    expect(archivedRows).toHaveLength(13);
  });

  it("shows every row the archived summary counts", async () => {
    // The clean assertion, stated as the equality the old slice broke: the summary
    // is derived from the same array the list renders, so the two can never
    // disagree. Pre-fix this read twelve rows against a summary saying thirteen.
    const archived = Array.from({ length: 13 }, (_unused, index) =>
      channel(`${CHANNEL_OLD}-${String(index)}`, "archived", `old-${String(index)}`),
    );
    const { container } = await renderChannelListSettled(loaded([mainChannel(), ...archived]));
    const summaryText =
      container.querySelector(".meridian-channels__archive-summary")?.textContent ?? "";
    const renderedArchivedRowCount = container.querySelectorAll(
      ".meridian-channels__list--archived .meridian-channel-row",
    ).length;
    expect(summaryText).toContain(`${String(renderedArchivedRowCount)} archived channels`);
  });

  it("negative control: a small archived set still renders exactly what it was served", async () => {
    const { container } = await renderChannelListSettled(
      loaded([mainChannel(), channel(CHANNEL_OLD, "archived", "old")]),
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
  /** Every control on the row at this position, the open one included. */
  function controlsOfRow(container: HTMLElement, rowIndex: number): readonly HTMLButtonElement[] {
    const row = container.querySelectorAll(".meridian-channels__list > .meridian-channel-row")[
      rowIndex
    ];
    return [...(row?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  }

  it("opens the channel through the registered pane kind and entity kind", async () => {
    const openPane = vi.fn();
    const { container } = await renderChannelListSettled(loaded([mainChannel()]), { openPane });
    container.querySelector<HTMLButtonElement>(".meridian-channel-row__open")?.click();
    expect(openPane).toHaveBeenCalledWith({
      kind: "timeline",
      entity: { kind: "channel", id: CHANNEL_MAIN },
    });
  });

  it("keeps opening the channel one control, with the acts beside it and not inside it", async () => {
    // A control inside a control is one target a keyboard cannot separate, so the
    // name and its marks are the whole of the open button and the lifecycle moves sit
    // outside it as siblings.
    const { container } = await renderChannelListSettled(loaded([mainChannel()]));
    const open = container.querySelector<HTMLButtonElement>(".meridian-channel-row__open");
    expect(open?.getAttribute("type")).toBe("button");
    expect(open?.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll(".meridian-channel-row__open")).toHaveLength(1);
  });

  it("offers mute and archive on a live row and never the opposite of the state it is in", async () => {
    const { container } = await renderChannelListSettled(loaded([mainChannel()]));
    const labels = controlsOfRow(container, 0).map((control) => control.textContent ?? "");
    expect(labels).toStrictEqual([expect.stringContaining(MAIN_CHANNEL_NAME), "Mute", "Archive"]);
  });

  it("offers unmute on a muted row, because offering mute there is offering a done act", async () => {
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_RELAY, "muted", "relay")]),
    );
    const labels = controlsOfRow(container, 0).map((control) => control.textContent ?? "");
    expect(labels).toContain("Unmute");
    expect(labels).not.toContain("Mute");
  });

  it("offers nothing at all on an archived row, unmute included", async () => {
    // Archival is terminal. An unmute affordance there would suggest the channel could
    // come back, which is the one thing this state means it cannot.
    const { container } = await renderChannelListSettled(
      loaded([mainChannel(), channel(CHANNEL_OLD, "archived", "old")]),
    );
    const archivedControls = [
      ...container.querySelectorAll<HTMLButtonElement>(".meridian-channels__list--archived button"),
    ].map((control) => control.className);
    expect(archivedControls).toStrictEqual(["meridian-channel-row__open"]);
  });

  it("offers no pause-channel, no mute-participant, and no configuration-update control", async () => {
    // None of the three has a verb anywhere in the corpus: `channel.pause` and a
    // per-channel participant mute do not exist, and every `ChannelConfig` member is
    // fixed at creation, which is what the panel below says out loud.
    const { container } = await renderChannelListSettled(
      loaded([mainChannel(), channel(CHANNEL_RELAY, "muted", "relay")]),
    );
    const controlText = [...container.querySelectorAll("button")]
      .map((control) => `${control.textContent ?? ""} ${control.getAttribute("aria-label") ?? ""}`)
      .join(" ")
      .toLowerCase();
    expect(controlText).not.toContain("pause");
    expect(controlText).not.toContain("mute participant");
    expect(controlText).not.toContain("edit");
    expect(controlText).not.toContain("settings");
  });

  it("shows no count of rows it was not served", async () => {
    // The non-disclosure filter is the daemon's, and a "N more you cannot see" line
    // would leak exactly what the omission protects.
    const { container } = await renderChannelListSettled(loaded([mainChannel()]));
    const text = (container.textContent ?? "").toLowerCase();
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("cannot see");
  });
});

describe("channel list — the absences", () => {
  it("names main immediately and draws the rest as skeletons", async () => {
    // Every session has the bootstrap channel, so naming it before the read lands
    // asserts nothing the reply could contradict — and it carries no control, because
    // its id is the read's to supply.
    const { container } = await renderChannelListSettled({ kind: "not-loaded" });
    expect(container.querySelector(".meridian-channel-row--loading")?.textContent).toBe(
      MAIN_CHANNEL_NAME,
    );
    expect(container.querySelector(".meridian-channels__list--loading button")).toBeNull();
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
  });

  it("renders the daemon's refusal verbatim, code and message", async () => {
    const { container } = await renderChannelListSettled({
      kind: "failed",
      refusal: refuse("daemon", "channel.not_found", "That channel is gone."),
    });
    const text = container.textContent ?? "";
    expect(text).toContain("channel.not_found");
    expect(text).toContain("That channel is gone.");
  });

  it("offers a way back into a stream that refused to open", async () => {
    // A refused subscribe is terminal for the read, exactly as it is for the roster
    // beside it: nothing re-runs the effect that opened it, so a column with no
    // control is a directory a person cannot get back.
    let reopenCount = 0;
    const { container } = await renderChannelListSettled(
      { kind: "failed", refusal: refuse("daemon", "ratelimit.exceeded", "Too many streams.") },
      {
        onReopen: () => {
          reopenCount += 1;
        },
      },
    );
    const retry = container.querySelector(".meridian-refusal__action button");
    expect(retry?.textContent).toBe("Try again");
    (retry as HTMLButtonElement).click();
    expect(reopenCount).toBe(1);
  });

  it("negative control: a served directory offers no re-open", async () => {
    // Without this, the case above would pass over a column that offered the control
    // on every arm, which reads as a refresh this surface does not have.
    const { container } = await renderChannelListSettled(loaded([mainChannel()]));
    expect(container.querySelector(".meridian-refusal__action")).toBeNull();
  });

  it("teaches what a channel is for when there is none to show", async () => {
    const { container } = await renderChannelListSettled(loaded([]));
    expect(container.textContent ?? "").toContain("a room of one topic");
  });

  it("still offers a way to create one when there is none to show", async () => {
    // The empty state is the bootstrap channel and the create affordance. A surface
    // that explained what a channel is for and then offered no way to make one would
    // be teaching a thing a person cannot do.
    const { container } = await renderChannelListSettled(loaded([]));
    expect(container.querySelector(".meridian-create-channel__submit")).not.toBeNull();
  });

  it("says the projection is catching up without marking individual rows", async () => {
    const { container } = await renderChannelListSettled(loaded([mainChannel()]), {
      isCatchingUp: true,
    });
    expect(container.querySelectorAll(".meridian-channels__degraded")).toHaveLength(1);
    expect(container.querySelectorAll(".meridian-channel-row")).toHaveLength(1);
  });

  it("negative control: a healthy projection renders no catching-up line", async () => {
    const { container } = await renderChannelListSettled(loaded([mainChannel()]));
    expect(container.querySelector(".meridian-channels__degraded")).toBeNull();
  });
});
