// Two sessions never share a draft key: a collision would show the text written in one session in
// another's composer.

import { describe, expect, it } from "vitest";

import { composerDraftKey } from "./draft-key.js";

describe("composerDraftKey — one draft per session", () => {
  it("gives two sessions different keys", () => {
    expect(composerDraftKey("session-1")).not.toBe(composerDraftKey("session-2"));
  });
});
