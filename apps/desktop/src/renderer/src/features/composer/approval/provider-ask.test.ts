// Tested alone over hand-built entities: the rule between the projector and the pane.

import { describe, expect, it } from "vitest";

import { providerAskFor } from "./provider-ask.js";
import { type StoredEntity } from "@renderer/store/session/entities/entities.js";

function approvalEntity(body: Readonly<Record<string, unknown>> | undefined): StoredEntity {
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
    // A wrong-typed or empty `askId` is not an ask id; "as ask ." is worse than the plain card.
    expect(providerAskFor(approvalEntity({ askId: "" }))).toBeUndefined();
    expect(providerAskFor(approvalEntity({ askId: 7 }))).toBeUndefined();
  });
});
