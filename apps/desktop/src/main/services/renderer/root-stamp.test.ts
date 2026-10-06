// The stamp written on the console document's root keeps what the built tag already carries.

import { describe, expect, it } from "vitest";

import { stampRootElement } from "./root-stamp.js";

describe("the root stamp", () => {
  it("merges a style the built tag carries into the stamped one", () => {
    const stamped = stampRootElement('<html lang="en" style="color-scheme:light dark;">', {
      record: {
        theme: "meridian",
        scheme: "dark",
        textSize: 18,
        transcriptWidth: 40,
        grounds: { light: "#ffffff", dark: "#101010" },
      },
      platformScheme: "light",
      isSafeStart: false,
    });

    expect(stamped).toBe(
      '<html lang="en" data-theme="meridian" data-color-scheme="dark" ' +
        'data-resolved-color-scheme="dark" ' +
        'style="color-scheme:light dark;font-size:18px;--meridian-transcript-width:40rem">',
    );
  });
});
