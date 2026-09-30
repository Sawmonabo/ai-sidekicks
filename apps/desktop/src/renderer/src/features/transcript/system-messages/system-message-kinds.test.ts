// The seam vocabulary, held to the property a drifted table still renders: one that spread
// its caution across every epoch seam would still draw them, in amber.

import { describe, expect, it } from "vitest";

import { SYSTEM_MESSAGE_KINDS, SYSTEM_MESSAGE_BINDINGS } from "./system-message-kinds.js";

describe("seams — the one caution", () => {
  it("spends its one caution on the failed switch and on nothing else", () => {
    // Amber and red are rationed to attention and failure alone.
    const cautions = SYSTEM_MESSAGE_KINDS.filter((kind) => SYSTEM_MESSAGE_BINDINGS[kind].isCaution);
    expect(cautions).toStrictEqual(["provider-switch-failed"]);
  });
});
