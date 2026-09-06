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

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "../../core/settle.test-support.js";
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

/** Every lifecycle control on screen, in row order: mute or unmute, then archive. */
function acts(container: HTMLElement): readonly HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".meridian-channel-row__act")];
}

/** Every row still on screen, by the name it wears. */
function rowNames(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-channel-row__name")].map(
    (name) => name.textContent ?? "",
  );
}

/** Press one lifecycle control and let its answer land. */
async function press(container: HTMLElement, index: number): Promise<void> {
  act(() => {
    acts(container)[index]?.click();
  });
  await settle();
}

/** Open one row's archive confirmation and press through it. */
async function confirmArchive(container: HTMLElement, triggerIndex: number): Promise<void> {
  act(() => {
    acts(container)[triggerIndex]?.click();
  });
  act(() => {
    document.querySelector<HTMLButtonElement>(".meridian-channels__dialog-confirm")?.click();
  });
  await settle();
}

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
