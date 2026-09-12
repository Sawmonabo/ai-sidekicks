// What the create form collects, and what it never collects.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  createChannelElement,
  fieldNotes,
  policyFields,
  renderCreateChannel,
  typeName,
} from "./create-channel.test-support.js";

describe("creating a channel — the standing statement", () => {
  it("says the settings cannot be edited afterwards, above the control that commits", () => {
    const { container } = renderCreateChannel();
    const standing = container.querySelector(".meridian-create-channel__standing");
    expect(standing?.textContent ?? "").toContain("cannot be edited after it is created");
    expect(
      standing?.compareDocumentPosition(
        container.querySelector(".meridian-create-channel__submit") as Node,
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("names each decision creation settles", () => {
    const { container } = renderCreateChannel();
    const labels = [...container.querySelectorAll(".meridian-create-channel__decision-label")].map(
      (element) => element.textContent ?? "",
    );
    expect(labels).toStrictEqual(["Name", "How agents take turns"]);
  });

  it("offers no way to change any of it afterwards", () => {
    // `channel.configUpdate` is registered on no transport in V1. A control offered
    // against it would claim a capability the plane does not have.
    const { container } = renderCreateChannel();
    const controlText = [...container.querySelectorAll("button")]
      .map((control) => control.textContent ?? "")
      .join(" ")
      .toLowerCase();
    expect(controlText).not.toContain("edit");
    expect(controlText).not.toContain("update");
    expect(controlText).not.toContain("save");
  });
});

describe("creating a channel — the policy it carries", () => {
  it("puts both members under one disclosure that opens by default", () => {
    // Open, because a create-time decision hidden behind a closed fold is a decision
    // made by not looking — and this is the only moment any of it can be made.
    const { container } = renderCreateChannel();
    const disclosure = container.querySelector<HTMLDetailsElement>(
      ".meridian-create-channel__policy",
    );
    expect(disclosure?.open).toBe(true);
  });

  it("collects every member of the configuration, each from its own vocabulary", () => {
    const { container } = renderCreateChannel();
    const fields = policyFields(container);

    expect(fields.turnsPerAgent.inputMode).toBe("numeric");
    expect(fields.moderationBoxes).toHaveLength(2);
  });

  it("labels every one of them fixed at creation", () => {
    const { container } = renderCreateChannel();
    const notes = fieldNotes(container).filter((note) => note.includes("Fixed at creation"));
    expect(notes).toHaveLength(2);
  });
});

describe("creating a channel — a form re-addressed to another session", () => {
  /**
   * A second session, so a case can re-address the SAME mount at one.
   *
   * UUID-shaped like the first for that harness's own reason, and distinct from it
   * because what is under test is exactly what happens when the two differ.
   */
  const SECOND_SESSION_ID = "019b7d10-0000-7000-8000-000000000002";

  it("drops the whole draft when the form is re-addressed to another session", () => {
    // Everything in this form is about the session it was typed in, so carrying it
    // across a re-address would offer Create for a channel in a session nobody typed it
    // for.
    const mounted = renderCreateChannel();
    typeName(mounted.container, "review");

    mounted.rerender(createChannelElement({ sessionId: SECOND_SESSION_ID }, mounted.bridge));

    expect(
      mounted.container.querySelector<HTMLInputElement>(".meridian-create-channel__name")?.value,
    ).toBe("");
  });

  it("negative control: a re-render that changes neither keeps what was typed", () => {
    // Without this the case above would pass over a form that threw its draft away on
    // every pass, which would drop a person's work for no reason at all.
    const mounted = renderCreateChannel();
    typeName(mounted.container, "review");

    mounted.rerender(createChannelElement({}, mounted.bridge));

    expect(
      mounted.container.querySelector<HTMLInputElement>(".meridian-create-channel__name")?.value,
    ).toBe("review");
  });
});

describe("creating a channel — the reserved bootstrap name", () => {
  it("marks the name field and names the word that is reserved", () => {
    const { container } = renderCreateChannel();
    typeName(container, MAIN_CHANNEL_NAME);
    const marked = container.querySelector(".meridian-create-channel__field-refusal");
    expect(marked?.textContent ?? "").toContain(MAIN_CHANNEL_NAME);
  });

  it("refuses to submit while that name stands", () => {
    const { container } = renderCreateChannel();
    typeName(container, MAIN_CHANNEL_NAME);
    expect(
      container.querySelector<HTMLButtonElement>(".meridian-create-channel__submit")?.disabled,
    ).toBe(true);
  });

  it("negative control: another name marks nothing and opens the control", () => {
    const { container } = renderCreateChannel();
    typeName(container, "review");
    expect(container.querySelector(".meridian-create-channel__field-refusal")).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(".meridian-create-channel__submit")?.disabled,
    ).toBe(false);
  });

  it("says what it is still waiting for rather than leaving the control merely shut", () => {
    const { container } = renderCreateChannel();
    expect(
      container.querySelector(".meridian-create-channel__incomplete")?.textContent ?? "",
    ).toContain("a name");
  });
});

describe("creating a channel — what it never collects", () => {
  it("takes exactly one value per member of the create request, and no other", () => {
    // Five controls: the name, and the four the configuration is made of. A field whose
    // value can go nowhere reads as a broken feature, and there is none here.
    const { container } = renderCreateChannel();
    expect(container.querySelectorAll("input, select, textarea")).toHaveLength(5);
  });
});
