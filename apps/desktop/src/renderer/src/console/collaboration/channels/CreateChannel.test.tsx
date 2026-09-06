// What the create form collects, and which fields exist for which kind of channel.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  GROWTH_CHANNEL_AUDIENCES,
  GROWTH_CHANNEL_KINDS,
  GROWTH_CHANNEL_TURN_POLICIES,
} from "../../bridge/index.js";
import {
  PARTICIPANT_OTHER,
  chooseKind,
  fieldNotes,
  policyFields,
  renderCreateChannel,
  typeName,
} from "./channels.test-support.js";

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
    expect(labels).toStrictEqual(["Name", "Who it is for", "How agents take turns"]);
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

describe("creating a channel — where the form opens", () => {
  it("opens on a general channel", () => {
    const { container } = renderCreateChannel();
    const pressed = [...container.querySelectorAll(".meridian-create-channel__kind")]
      .filter((kind) => kind.getAttribute("aria-pressed") === "true")
      .map((kind) => kind.textContent ?? "");
    expect(pressed).toStrictEqual(["A named channel"]);
  });

  it("opens with the audience already on participants", () => {
    const { container } = renderCreateChannel();
    expect(policyFields(container).audience.value).toBe("participants");
  });

  it("offers one control per registered kind and no third", () => {
    const { container } = renderCreateChannel();
    expect(container.querySelectorAll(".meridian-create-channel__kind")).toHaveLength(
      GROWTH_CHANNEL_KINDS.length,
    );
  });

  it("keeps the name and the kind visible whichever kind is chosen", () => {
    // One screen, one job: the two decisions everybody makes stay on it, and the
    // policy is what folds.
    const { container } = renderCreateChannel();
    chooseKind(container, "direct");
    expect(container.querySelector(".meridian-create-channel__name")).not.toBeNull();
    expect(container.querySelectorAll(".meridian-create-channel__kind")).toHaveLength(2);
  });
});

describe("creating a channel — the policy a general channel carries", () => {
  it("puts the five members under one disclosure that opens by default", () => {
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
    const optionValues = (select: HTMLSelectElement): readonly string[] =>
      [...select.options].map((option) => option.value).filter((value) => value !== "");

    expect(optionValues(fields.audience)).toStrictEqual([...GROWTH_CHANNEL_AUDIENCES]);
    expect(optionValues(fields.turnPolicy)).toStrictEqual([...GROWTH_CHANNEL_TURN_POLICIES]);
    expect(fields.roundRobinOrder.placeholder).toContain("separated by commas");
    expect(fields.turnsPerAgent.inputMode).toBe("numeric");
    expect(fields.moderationBoxes).toHaveLength(2);
  });

  it("labels every one of them fixed at creation", () => {
    const { container } = renderCreateChannel();
    const notes = fieldNotes(container).filter((note) => note.includes("Fixed at creation"));
    expect(notes).toHaveLength(5);
  });

  it("offers the session's own default as an explicit choice rather than pre-picking one", () => {
    // An absent member on this wire MEANS the session's default, so a console that
    // filled one in would be choosing on a person's behalf and reporting it as theirs.
    const { container } = renderCreateChannel();
    expect(policyFields(container).turnPolicy.value).toBe("");
    expect(
      [...policyFields(container).turnPolicy.options].map((option) => option.textContent),
    ).toContain("Session default");
  });
});

describe("creating a channel — the direct arm", () => {
  it("drops the four agent-turn fields rather than disabling them", () => {
    // A disabled field says a value could be set here and is being withheld, which on
    // this arm is untrue: the wire's own validation refuses every one of them.
    const { container } = renderCreateChannel();
    chooseKind(container, "direct");

    expect(container.querySelector(".meridian-create-channel__policy")).toBeNull();
    expect(container.querySelectorAll(".meridian-create-channel__select")).toHaveLength(0);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(container.querySelectorAll("select:disabled")).toHaveLength(0);
  });

  it("says it is humans-only and that its pair cannot change", () => {
    const { container } = renderCreateChannel();
    chooseKind(container, "direct");
    const note = container.querySelector(".meridian-create-channel__direct")?.textContent ?? "";
    expect(note).toContain("humans-only");
    expect(note).toContain("cannot change afterwards");
  });

  it("offers one picker holding everybody but this window's own participant", () => {
    const { container } = renderCreateChannel();
    chooseKind(container, "direct");
    const candidates = [...container.querySelectorAll(".meridian-create-channel__candidate")].map(
      (candidate) => candidate.textContent ?? "",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0] ?? "").toContain(PARTICIPANT_OTHER);
  });

  it("marks the person a picker chose", () => {
    const { container } = renderCreateChannel();
    chooseKind(container, "direct");
    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-create-channel__candidate")?.click();
    });
    expect(
      container.querySelector(".meridian-create-channel__candidate")?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("says which read it is waiting on where this window's participant is unknown", () => {
    // `not-checked` and not `empty`: the pair cannot be composed until that read
    // answers, and saying "there is nobody" instead would be a claim about the session.
    const { container } = renderCreateChannel({ viewerParticipantId: undefined });
    chooseKind(container, "direct");
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("says nobody else is here yet where this session holds one person", () => {
    const { container } = renderCreateChannel({ participantIds: [] });
    chooseKind(container, "direct");
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it("negative control: the general arm draws neither absence and keeps the five", () => {
    const { container } = renderCreateChannel({ viewerParticipantId: undefined });
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
    expect(container.querySelector(".meridian-create-channel__policy")).not.toBeNull();
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
    typeName(container, "review");
    chooseKind(container, "direct");
    expect(
      container.querySelector(".meridian-create-channel__incomplete")?.textContent ?? "",
    ).toContain("the other person in the pair");
  });
});

describe("creating a channel — what it never collects", () => {
  it("takes exactly one value per member of the create request, and no other", () => {
    // Seven controls: the name, and the six the configuration is made of. A field
    // whose value can go nowhere reads as a broken feature, and there is none here.
    const { container } = renderCreateChannel();
    expect(container.querySelectorAll("input, select, textarea")).toHaveLength(7);
  });

  it("takes one value and no other on the direct arm too", () => {
    // The pair, picked. Every configuration member is absent rather than disabled.
    const { container } = renderCreateChannel();
    chooseKind(container, "direct");
    expect(container.querySelectorAll("input, select, textarea")).toHaveLength(1);
  });
});
