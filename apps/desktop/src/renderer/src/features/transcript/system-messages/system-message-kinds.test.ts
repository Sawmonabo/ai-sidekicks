// The seam vocabulary, held to the property a drifted table still renders: one that
// had spread its caution across every epoch seam still draws them — in amber.
//
// THE CLASSIFIER IS NOT HERE. `system-message-classifier.test.ts` drives the epoch rule — which rows are
// seams and what one row's seam reads — on the same split the source takes.

import { describe, expect, it } from "vitest";

import { SYSTEM_MESSAGE_KINDS, SYSTEM_MESSAGE_BINDINGS } from "./system-message-kinds.js";

describe("seams — the one caution", () => {
  it("spends its one caution on the failed switch and on nothing else", () => {
    // Amber and red are rationed to attention and failure. A table that had
    // drifted into marking every epoch seam would still render — in amber.
    const cautions = SYSTEM_MESSAGE_KINDS.filter((kind) => SYSTEM_MESSAGE_BINDINGS[kind].isCaution);
    expect(cautions).toStrictEqual(["provider-switch-failed"]);
  });
});
