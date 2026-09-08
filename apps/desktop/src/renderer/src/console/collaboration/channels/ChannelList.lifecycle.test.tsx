// The three acts a row offers, where each one goes, and what two refusals do to it.
//
// EVERY CASE DRIVES THE REAL PORT. A scripted daemon refusal is thrown back verbatim
// and unwrapped, so these assert against the code and the sentence a daemon actually
// sends — and against a coordinator that has to settle a REJECTION, which is the arm
// that leaves every control on the list shut forever when it is missed.
//
// WHERE A CONTROL GOES IS ASSERTED THROUGH THE REFUSAL IT EARNS. An operation the
// scenario scripts nothing for refuses by naming the call, so a rendered
// `channel.archive` is the archive control reporting which verb it reached. That is
// stronger than a spy on the port: it goes through the registry's own id-to-method
// fold rather than around it.
//
// WHAT AN ANSWERED ACT DOES TO THE ROW IS THE SIBLING FILE. Every case here reads a
// refusal or a verb; `ChannelList.receipt.test.tsx` reads the row a served receipt
// moved, and the two share this directory's one cast.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "../../core/settle.test-support.js";
import { acts, confirmArchive, press, rowNames } from "./channel-rows.test-support.js";
import {
  CHANNEL_OLD,
  CHANNEL_RELAY,
  CHANNEL_REVIEW,
  channel,
  channelsBridge,
  loaded,
  mainChannel,
  renderChannelListSettled,
  scenarioAnswering,
  scenarioRefusing,
} from "./channels.test-support.js";

describe("channel list — where each act goes", () => {
  it("sends a mute to the channel-mute verb", async () => {
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review")]),
    );
    await press(container, 0);
    expect(container.textContent ?? "").toContain("channel.mute");
  });

  it("sends an unmute to the channel-unmute verb", async () => {
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_RELAY, "muted", "relay")]),
    );
    await press(container, 0);
    expect(container.textContent ?? "").toContain("channel.unmute");
  });

  it("sends an archive to the channel-archive verb, and only once confirmed", async () => {
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review")]),
    );

    // Opening the confirmation is not the act. Archival is terminal and the opposite
    // control does not undo it, so the trigger asks and the dialog commits.
    act(() => {
      acts(container)[1]?.click();
    });
    await settle();
    expect(container.textContent ?? "").not.toContain("channel.archive");

    act(() => {
      document.querySelector<HTMLButtonElement>(".meridian-channels__dialog-confirm")?.click();
    });
    await settle();
    expect(container.textContent ?? "").toContain("channel.archive");
  });

  it("negative control: an act the daemon answers leaves no refusal behind", async () => {
    // Without this, every case above would pass over a list that refused every press.
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review")]),
      {
        bridge: channelsBridge({
          scenario: scenarioAnswering("channel.mute", {
            channelId: CHANNEL_REVIEW,
            state: "muted",
          }),
        }),
      },
    );

    await press(container, 0);

    expect(container.querySelector(".meridian-channel-row__acts .meridian-refusal")).toBeNull();
    expect(acts(container).some((control) => control.disabled)).toBe(false);
  });
});

describe("channel list — one act at a time", () => {
  it("closes every row's controls while one act is unsettled", async () => {
    const { container } = await renderChannelListSettled(
      loaded([mainChannel(), channel(CHANNEL_REVIEW, "active", "review")]),
    );
    expect(acts(container)).toHaveLength(4);
    expect(acts(container).some((control) => control.disabled)).toBe(false);

    // A SYNCHRONOUS act on purpose: the coordinator publishes its pending key before
    // the call it awaits settles, so this reads the tree at exactly the moment one
    // move is in flight. An awaiting act would flush the answer and find it at rest.
    act(() => {
      acts(container)[0]?.click();
    });

    expect(acts(container).every((control) => control.disabled)).toBe(true);
    // The row that was pressed says what it is doing; its neighbours are only shut.
    expect(acts(container)[0]?.textContent).toBe("Muting…");
    expect(acts(container)[2]?.textContent).toBe("Mute");
    await settle();
  });

  it("negative control: every control opens again once that act settles", async () => {
    const { container } = await renderChannelListSettled(
      loaded([mainChannel(), channel(CHANNEL_REVIEW, "active", "review")]),
    );

    await press(container, 0);

    expect(acts(container).some((control) => control.disabled)).toBe(false);
  });
});

describe("channel list — the row a refused second press must not relabel", () => {
  /** One control, addressed by the sentence a person reads on it. */
  function control(container: HTMLElement, label: string): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    if (found === null) {
      throw new Error(`no control labelled ${label}`);
    }
    return found;
  }

  it("keeps the pressed row's own verb when a neighbour's act is refused mid-flight", async () => {
    // The archive CONFIRMATION is the second press that reaches the handler while the
    // first is unsettled, and it is not a contrived one: only the trigger carries the
    // pending gate, and this dialog was opened before anything was in flight. The
    // coordinator answers it under its single-flight rule and keeps the mute as the
    // pending row — so the mute's own row must still say what it is doing.
    const { container } = await renderChannelListSettled(
      loaded([
        channel(CHANNEL_REVIEW, "active", "review"),
        channel(CHANNEL_RELAY, "active", "relay"),
      ]),
    );

    act(() => {
      control(container, "Archive relay").click();
    });
    act(() => {
      control(container, "Mute review").click();
    });
    act(() => {
      document.querySelector<HTMLButtonElement>(".meridian-channels__dialog-confirm")?.click();
    });

    expect(control(container, "Mute review").textContent).toBe("Muting…");
    expect(control(container, "Archive review").textContent).toBe("Archive");
    // And the refused press is ANSWERED rather than dropped, on the row that made it.
    expect(container.textContent ?? "").toContain("mutation-in-flight");
    await settle();
  });

  it("negative control: the pressed row says nothing once its own act settles", async () => {
    // Without this the case above would pass over a list that rendered "Muting…"
    // whatever had happened, which is a label rather than a pending state.
    const { container } = await renderChannelListSettled(
      loaded([
        channel(CHANNEL_REVIEW, "active", "review"),
        channel(CHANNEL_RELAY, "active", "relay"),
      ]),
    );

    await press(container, 0);

    expect(control(container, "Mute review").textContent).toBe("Mute");
  });
});

describe("channel list — a channel that is gone", () => {
  const goneScenario = scenarioRefusing(
    "channel.mute",
    "channel.not_found",
    "That channel is gone.",
  );

  it("takes the row away and stands the daemon's own sentence in its place", async () => {
    const { container } = await renderChannelListSettled(
      loaded([mainChannel(), channel(CHANNEL_REVIEW, "active", "review")]),
      { bridge: channelsBridge({ scenario: goneScenario }) },
    );

    await press(container, 2);

    const notice = container.querySelector(".meridian-channels__gone");
    expect(notice?.textContent ?? "").toContain("channel.not_found");
    expect(notice?.textContent ?? "").toContain("That channel is gone.");
    expect(rowNames(container)).toStrictEqual([MAIN_CHANNEL_NAME]);
  });

  it("offers nothing on the notice that replaced the row", async () => {
    // A control on a channel that no longer exists offers an act that can only fail.
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review")]),
      { bridge: channelsBridge({ scenario: goneScenario }) },
    );

    await press(container, 0);

    expect(container.querySelector(".meridian-channels__gone button")).toBeNull();
    expect(acts(container)).toHaveLength(0);
  });

  it("leaves every other row exactly where it was", async () => {
    const { container } = await renderChannelListSettled(
      loaded([mainChannel(), channel(CHANNEL_REVIEW, "active", "review")]),
      { bridge: channelsBridge({ scenario: goneScenario }) },
    );

    await press(container, 2);

    expect(rowNames(container)).toStrictEqual([MAIN_CHANNEL_NAME]);
    expect(acts(container)).toHaveLength(2);
  });
});

describe("channel list — a channel that is archived", () => {
  const inactiveScenario = scenarioRefusing(
    "channel.mute",
    "channel.inactive",
    "That channel is archived.",
  );

  it("keeps the row and renders the refusal against it", async () => {
    // A different fact from `channel.not_found`: the channel still exists, so its row
    // is still true and the reason belongs beside the control that asked.
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review")]),
      { bridge: channelsBridge({ scenario: inactiveScenario }) },
    );

    await press(container, 0);

    const acted = container.querySelector(".meridian-channel-row__acts");
    expect(acted?.textContent ?? "").toContain("channel.inactive");
    expect(acted?.textContent ?? "").toContain("That channel is archived.");
    expect(container.querySelectorAll(".meridian-channel-row")).toHaveLength(1);
    expect(container.querySelector(".meridian-channels__gone")).toBeNull();
    // And the controls are open again. A rejection the coordinator never settles
    // leaves the pending key held and every control on this list shut for the life of
    // the window, behind a spinner over an answer that already arrived.
    expect(acts(container).some((control) => control.disabled)).toBe(false);
  });

  it("lets a person put that reason away without leaving the row", async () => {
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review")]),
      { bridge: channelsBridge({ scenario: inactiveScenario }) },
    );
    await press(container, 0);
    expect(container.querySelector(".meridian-channel-row__acts .meridian-refusal")).not.toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-channel-row__refusal-dismiss")?.click();
    });

    expect(container.querySelector(".meridian-channel-row__acts .meridian-refusal")).toBeNull();
    expect(container.querySelectorAll(".meridian-channel-row")).toHaveLength(1);
  });
});

describe("channel list — the archived region", () => {
  it("offers no act on a row that is already archived", async () => {
    const { container } = await renderChannelListSettled(
      loaded([mainChannel(), channel(CHANNEL_OLD, "archived", "old")]),
    );
    expect(
      container.querySelectorAll(".meridian-channels__list--archived .meridian-channel-row__act"),
    ).toHaveLength(0);
  });

  it("negative control: the live row beside it still offers both", async () => {
    const { container } = await renderChannelListSettled(
      loaded([mainChannel(), channel(CHANNEL_OLD, "archived", "old")]),
    );
    expect(acts(container)).toHaveLength(2);
  });

  it("confirms an archive before performing it, on the live row", async () => {
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review")]),
      {
        bridge: channelsBridge({
          scenario: scenarioAnswering("channel.archive", {
            channelId: CHANNEL_REVIEW,
            state: "archived",
          }),
        }),
      },
    );

    await confirmArchive(container, 1);

    expect(container.querySelector(".meridian-channel-row__acts .meridian-refusal")).toBeNull();
  });
});
