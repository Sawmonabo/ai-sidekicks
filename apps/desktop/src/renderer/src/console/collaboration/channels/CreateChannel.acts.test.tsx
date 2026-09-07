// The two acts the create form offers, and where each refusal it can earn lands.
//
// Driven against the real fixture, so a scripted daemon refusal arrives the way one
// will: thrown from the growth port, unwrapped, carrying the daemon's own dotted code.
// That is what makes routing a refusal to a FIELD assertable at all — a paraphrased
// code would collapse the three destinations into one.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  growthAnswering,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { settle } from "../../core/settle.test-support.js";
import {
  PARTICIPANT_OTHER,
  channelsBridge,
  scenarioAnswering,
  scenarioRefusing,
} from "./channels.test-support.js";
import { chooseKind, renderCreateChannel, typeName } from "./create-channel.test-support.js";

const CHANNEL_CREATE_CALL = "channel.create";
const CREATED_CHANNEL_ID = "channel-created";

/** The receipt every served create in this file answers with. */
const CREATE_RECEIPT = {
  channelId: CREATED_CHANNEL_ID,
  state: "active",
  createdAt: "2026-01-08T10:05:00.000Z",
} as const;

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

/** What the name field currently reads. */
function nameFieldValue(container: HTMLElement): string {
  return container.querySelector<HTMLInputElement>(".meridian-create-channel__name")?.value ?? "";
}

/**
 * A form whose create is held OPEN, and the release that settles it.
 *
 * The create is answered through the growth port rather than through the scenario,
 * because a scripted reply settles when the call is made and what these cases are about
 * is the window in between. `growthAnswering` is the seam's own lazy arm: the answer is
 * decided at the moment of the call, so the case decides when that moment ends.
 */
function formWithCreateHeldOpen(): {
  readonly container: HTMLElement;
  readonly settleCreate: () => Promise<void>;
} {
  let release: (() => void) | undefined;
  const answered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { container } = renderCreateChannel({
    bridge: fixtureBridgeWithGrowth(scenarioAnswering(CHANNEL_CREATE_CALL, CREATE_RECEIPT), {
      channelCreate: growthAnswering(async () => {
        await answered;
        return CREATE_RECEIPT;
      }),
    }),
  });
  return {
    container,
    settleCreate: async () => {
      release?.();
      await settle();
    },
  };
}

/** Press Create without waiting for it, which is what leaves the call in flight. */
function pressCreate(container: HTMLElement): void {
  act(() => {
    container.querySelector<HTMLButtonElement>(".meridian-create-channel__submit")?.click();
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

describe("creating a channel — what settles while the call is out", () => {
  it("keeps what was typed while the create was in flight", async () => {
    // The defect. The form stays live for the round trip on purpose — a text box that
    // went dead mid-trip would drop keystrokes a person had already committed — and the
    // reset a served create earns was applied to whatever the draft held when the
    // receipt landed rather than to the draft the create was sent from. So a person who
    // started their next channel while the first was out watched it disappear.
    const form = formWithCreateHeldOpen();
    typeName(form.container, "review");
    pressCreate(form.container);

    typeName(form.container, "the next one");
    await form.settleCreate();

    expect(nameFieldValue(form.container)).toBe("the next one");
    expect(
      form.container.querySelector(".meridian-create-channel__receipt")?.textContent,
    ).toContain(CREATED_CHANNEL_ID);
  });

  it("negative control: a draft nobody touched still empties when the create settles", async () => {
    // Through the same held-open create, so the two cases differ in exactly one thing —
    // whether a key was pressed while the call was out. Without it the case above would
    // pass over a form that had simply stopped resetting, which is the other way to keep
    // an edit and would leave every next channel starting from the last one's fields.
    const form = formWithCreateHeldOpen();
    typeName(form.container, "review");
    pressCreate(form.container);

    await form.settleCreate();

    expect(nameFieldValue(form.container)).toBe("");
  });
});
