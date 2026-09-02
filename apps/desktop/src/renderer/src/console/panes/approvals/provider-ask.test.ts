// The one reading that decides whether an approval is a provider's permission ask.
//
// Tested alone, over hand-built entities, because that is what the function takes: a
// stored entity and nothing else. The projector's own test proves the entity carries
// what the wire sent, and the pane's proves the framing reaches the card — this one
// proves the rule between them, including the arm no conformant daemon can produce.

import { describe, expect, it } from "vitest";

import { countAsksMissingDeadline, providerAskFor } from "./provider-ask.js";
import { type ConsoleEntity } from "../../store/index.js";

function approvalEntity(body: Readonly<Record<string, unknown>> | undefined): ConsoleEntity {
  return {
    kind: "approval",
    id: "approval-1",
    ...(body === undefined ? {} : { body }),
  };
}

describe("reading a provider ask off a stored approval", () => {
  it("answers the ask when the body carries both members", () => {
    expect(
      providerAskFor(
        approvalEntity({ askId: "ask-force-push", expiryAt: "2026-01-01T17:30:00.000Z" }),
      ),
    ).toStrictEqual({ askId: "ask-force-push", expiryAt: "2026-01-01T17:30:00.000Z" });
  });

  it("answers the ask with no deadline where the body broke the wire's pairing", () => {
    // Not representable against a conformant daemon — the emission seam refuses an
    // `askId`-bearing request without its shared deadline — and still a shape this
    // build can be handed. Dropping the framing would hide a provider ask because
    // one of its two members was missing.
    expect(providerAskFor(approvalEntity({ askId: "ask-force-push" }))).toStrictEqual({
      askId: "ask-force-push",
      expiryAt: undefined,
    });
  });

  it("invents no deadline from anything else the body carries", () => {
    // `createdAt`-shaped members are exactly what a surface reaches for when it
    // wants a countdown and has none. The answer is still an absent deadline.
    expect(
      providerAskFor(approvalEntity({ askId: "ask-force-push", touchedAt: "2026-01-01T13:00:00Z" }))
        ?.expiryAt,
    ).toBeUndefined();
  });

  it("answers nothing for the four shapes that are not an ask", () => {
    expect(providerAskFor(undefined)).toBeUndefined();
    expect(providerAskFor(approvalEntity(undefined))).toBeUndefined();
    expect(providerAskFor(approvalEntity({ category: "file_write" }))).toBeUndefined();
    // A wrong-typed or empty `askId` is not an ask id, and rendering "as ask ." is
    // worse than rendering the ordinary card.
    expect(providerAskFor(approvalEntity({ askId: "" }))).toBeUndefined();
    expect(providerAskFor(approvalEntity({ askId: 7 }))).toBeUndefined();
  });
});

describe("counting the asks that arrived without a deadline", () => {
  it("counts only the asks, and only the ones missing a deadline", () => {
    expect(
      countAsksMissingDeadline([
        { askId: "ask-1", expiryAt: "2026-01-01T17:30:00.000Z" },
        { askId: "ask-2", expiryAt: undefined },
        undefined,
        { askId: "ask-3", expiryAt: undefined },
      ]),
    ).toBe(2);
  });

  it("negative control: a list with nothing missing counts none", () => {
    // Without it, a counter that answered its input's length would pass the case
    // above whenever the fixture happened to have two of them.
    expect(
      countAsksMissingDeadline([
        { askId: "ask-1", expiryAt: "2026-01-01T17:30:00.000Z" },
        undefined,
      ]),
    ).toBe(0);
  });
});
