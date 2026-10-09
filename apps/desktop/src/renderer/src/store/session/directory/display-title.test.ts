// The order a session's on-screen title is chosen in: its name, its first message's preview, the
// words an untitled session reads by, and nothing where the shape is unknown too.

import { describe, expect, it } from "vitest";

import { sessionDisplayTitleOf } from "./display-title.js";

describe("sessionDisplayTitleOf", () => {
  it("falls back from the name to the preview to the untitled words, and names nothing last", () => {
    const preview = "Why does the build cache miss";

    expect(
      sessionDisplayTitleOf({
        name: "Storage backends",
        firstMessagePreview: preview,
        shape: "chat",
      }),
    ).toStrictEqual({ text: "Storage backends", isUntitled: false });
    expect(sessionDisplayTitleOf({ firstMessagePreview: preview, shape: "chat" })).toStrictEqual({
      text: preview,
      isUntitled: false,
    });
    expect(sessionDisplayTitleOf({ shape: "chat" })).toStrictEqual({
      text: "New chat",
      isUntitled: true,
    });
    expect(sessionDisplayTitleOf({ shape: "project" })).toStrictEqual({
      text: "New session",
      isUntitled: true,
    });
    // The row then tells the session apart by its id.
    expect(sessionDisplayTitleOf({ shape: undefined })).toBeUndefined();
  });
});
