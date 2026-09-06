// The two acts the create form offers, and where each refusal it can earn lands.
//
// Driven against the real fixture, so a scripted daemon refusal arrives the way one
// will: thrown from the growth port, unwrapped, carrying the daemon's own dotted code.
// That is what makes routing a refusal to a FIELD assertable at all — a paraphrased
// code would collapse the three destinations into one.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "../../core/settle.test-support.js";
import {
  PARTICIPANT_OTHER,
  channelsBridge,
  chooseKind,
  renderCreateChannel,
  scenarioAnswering,
  scenarioRefusing,
  typeName,
} from "./channels.test-support.js";

const CHANNEL_CREATE_CALL = "channel.create";
const CREATED_CHANNEL_ID = "channel-created";

/** Press Create and let its answer land. */
async function submit(container: HTMLElement): Promise<void> {
  act(() => {
    container.querySelector<HTMLButtonElement>(".meridian-create-channel__submit")?.click();
  });
  await settle();
}

/** Choose the direct arm and pick the one other person in the session. */
function pickTheOtherPerson(container: HTMLElement): void {
  chooseKind(container, "direct");
  act(() => {
    container.querySelector<HTMLButtonElement>(".meridian-create-channel__candidate")?.click();
  });
}

/** The refusal standing against the name field, if one is. */
function nameFieldRefusal(container: HTMLElement): string {
  const field = container
    .querySelector(".meridian-create-channel__name")
    ?.closest(".meridian-create-channel__field");
  return field?.querySelector(".meridian-refusal")?.textContent ?? "";
}

describe("creating a channel — one mutation per explicit action", () => {
  it("reaches the create verb and no other", async () => {
    const { container } = renderCreateChannel();
    typeName(container, "review");

    await submit(container);

    expect(container.textContent ?? "").toContain(CHANNEL_CREATE_CALL);
  });

  it("settles the control while the one call is in flight", async () => {
    const { container } = renderCreateChannel();
    typeName(container, "review");

    // Synchronous on purpose: the coordinator publishes its pending key before the
    // call it awaits settles, so this reads the tree while the create is unsettled.
    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-create-channel__submit")?.click();
    });

    const submitControl = container.querySelector<HTMLButtonElement>(
      ".meridian-create-channel__submit",
    );
    expect(submitControl?.textContent).toBe("Creating…");
    expect(submitControl?.disabled).toBe(true);
    expect(submitControl?.getAttribute("aria-busy")).toBe("true");
    expect(
      container.querySelector<HTMLButtonElement>(".meridian-create-channel__cancel")?.disabled,
    ).toBe(true);
    await settle();
  });

  it("keeps the form readable while it is in flight", async () => {
    // Settling the control is not clearing the screen: a person watching a create
    // should still be able to read what they asked for.
    const { container } = renderCreateChannel();
    typeName(container, "review");
    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-create-channel__submit")?.click();
    });

    expect(container.querySelector<HTMLInputElement>(".meridian-create-channel__name")?.value).toBe(
      "review",
    );
    await settle();
  });

  it("collects nothing until it can compose a request", () => {
    const { container } = renderCreateChannel();
    expect(
      container.querySelector<HTMLButtonElement>(".meridian-create-channel__submit")?.disabled,
    ).toBe(true);
  });

  it("shows the receipt the daemon answered with", async () => {
    const { container } = renderCreateChannel({
      bridge: channelsBridge({
        scenario: scenarioAnswering(CHANNEL_CREATE_CALL, {
          channelId: CREATED_CHANNEL_ID,
          state: "active",
          createdAt: "2026-01-08T10:05:00.000Z",
        }),
      }),
    });
    typeName(container, "review");

    await submit(container);

    const receipt = container.querySelector(".meridian-create-channel__receipt")?.textContent ?? "";
    expect(receipt).toContain(CREATED_CHANNEL_ID);
    expect(receipt).toContain("active");
  });

  it("empties the form once the create settled, so the next one starts clean", async () => {
    const { container } = renderCreateChannel({
      bridge: channelsBridge({
        scenario: scenarioAnswering(CHANNEL_CREATE_CALL, {
          channelId: CREATED_CHANNEL_ID,
          state: "active",
          createdAt: "2026-01-08T10:05:00.000Z",
        }),
      }),
    });
    typeName(container, "review");

    await submit(container);

    expect(container.querySelector<HTMLInputElement>(".meridian-create-channel__name")?.value).toBe(
      "",
    );
  });
});

describe("creating a channel — cancelling", () => {
  it("puts the form back without sending anything", async () => {
    // Renderer-local by definition: nothing was sent, so there is nothing to withdraw,
    // and a Cancel that reached the wire would invent an act the plane does not have.
    const { container } = renderCreateChannel();
    typeName(container, "review");
    pickTheOtherPerson(container);

    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-create-channel__cancel")?.click();
    });
    await settle();

    expect(container.querySelector<HTMLInputElement>(".meridian-create-channel__name")?.value).toBe(
      "",
    );
    expect(container.querySelector(".meridian-create-channel__policy")).not.toBeNull();
    expect(container.textContent ?? "").not.toContain(CHANNEL_CREATE_CALL);
    expect(container.querySelector(".meridian-create-channel__receipt")).toBeNull();
  });
});

describe("creating a channel — where each refusal lands", () => {
  it("marks the name field when the daemon says the name is reserved", async () => {
    // The console does not pre-empt the daemon's reserved list — it knows one word and
    // the daemon owns the set — so a name it had no objection to still lands here.
    const { container } = renderCreateChannel({
      bridge: channelsBridge({
        scenario: scenarioRefusing(
          CHANNEL_CREATE_CALL,
          "channel.name_reserved",
          "`general` is reserved on this node.",
        ),
      }),
    });
    typeName(container, "general");

    await submit(container);

    expect(nameFieldRefusal(container)).toContain("channel.name_reserved");
    expect(nameFieldRefusal(container)).toContain("`general` is reserved on this node.");
  });

  it("marks the picker when the person chosen is no longer a member", async () => {
    const { container } = renderCreateChannel({
      bridge: channelsBridge({
        scenario: scenarioRefusing(
          CHANNEL_CREATE_CALL,
          "channel.not_found",
          "That participant is no longer in this session.",
        ),
      }),
    });
    typeName(container, "with Dana");
    pickTheOtherPerson(container);

    await submit(container);

    const picker = container.querySelector(".meridian-create-channel__direct")?.textContent ?? "";
    expect(picker).toContain("channel.not_found");
    expect(picker).toContain(PARTICIPANT_OTHER);
    expect(nameFieldRefusal(container)).toBe("");
  });

  it("renders every other refusal under the control that asked", async () => {
    const { container } = renderCreateChannel({
      bridge: channelsBridge({
        scenario: scenarioRefusing(
          CHANNEL_CREATE_CALL,
          "channel.inactive",
          "That channel is archived.",
        ),
      }),
    });
    typeName(container, "review");

    await submit(container);

    // `channel.inactive` cannot arise from this form, and there is deliberately no
    // branch for it: an unforeseen refusal renders verbatim under the submit rather
    // than being routed by a rendering written for a refusal nobody can provoke.
    const beneath = container.querySelector(".meridian-create-channel > .meridian-refusal");
    expect(beneath?.textContent ?? "").toContain("channel.inactive");
    expect(nameFieldRefusal(container)).toBe("");
  });

  it("negative control: a create the daemon answers marks nothing at all", async () => {
    const { container } = renderCreateChannel({
      bridge: channelsBridge({
        scenario: scenarioAnswering(CHANNEL_CREATE_CALL, {
          channelId: CREATED_CHANNEL_ID,
          state: "active",
          createdAt: "2026-01-08T10:05:00.000Z",
        }),
      }),
    });
    typeName(container, "review");

    await submit(container);

    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });
});
