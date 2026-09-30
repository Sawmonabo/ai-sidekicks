// Staging's default media types leave out SVG, a picture that is also a document that
// can run script.
import { describe, expect, it } from "vitest";

import { SESSION_ATTACHMENT_DEFAULT_MEDIA_TYPES } from "../session-draft.js";

describe("the default media types staging admits", () => {
  it("leaves out SVG, a picture that is also a document that can run script", () => {
    expect(SESSION_ATTACHMENT_DEFAULT_MEDIA_TYPES).not.toContain("image/svg+xml");
  });
});
