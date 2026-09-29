// The one reading that decides whether an approval is a provider's permission ask.
//
// Tested alone, over hand-built entities, because that is what the function takes: a
// stored entity and nothing else. The projector's own test proves the entity carries
// what the wire sent, and the pane's proves the framing reaches the card — this one
// proves the rule between them.

import { describe, expect, it } from "vitest";

import { providerAskFor } from "./provider-ask.js";
import { type ConsoleEntity } from "@renderer/store/session/entities/entities.js";

function approvalEntity(body: Readonly<Record<string, unknown>> | undefined): ConsoleEntity {
  return {
    kind: "approval",
    id: "approval-1",
    ...(body === undefined ? {} : { body }),
  };
}

describe("reading a provider ask off a stored approval", () => {
  it("answers the ask when the body carries an ask id", () => {
    expect(providerAskFor(approvalEntity({ askId: "ask-force-push" }))).toStrictEqual({
      askId: "ask-force-push",
    });
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
