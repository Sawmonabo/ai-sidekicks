// The disposition is a pure function of two recorded lengths, so both arms run without
// rendering.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TruncationNotice, truncatedRemainderDisposition } from "./TruncationNotice.js";

const STORED_PREFIX = "The tool wrote a great deal and this is the first part of it.";
const STORED_PREFIX_BYTES = STORED_PREFIX.length;

describe("whether a truncated body's remainder can be named", () => {
  it("names the remainder when a longer length was recorded", () => {
    expect(truncatedRemainderDisposition(1024, 4096)).toStrictEqual({
      kind: "claimable",
      remainderByteCount: 3072,
    });
  });

  it("has no remainder when no pre-truncation length was recorded", () => {
    expect(truncatedRemainderDisposition(1024, undefined)).toStrictEqual({
      kind: "none-recorded",
    });
  });

  it("has no remainder when the recorded length does not exceed the prefix", () => {
    // Naming zero further bytes would report content that does not exist.
    expect(truncatedRemainderDisposition(1024, 1024)).toStrictEqual({ kind: "none-recorded" });
    expect(truncatedRemainderDisposition(1024, 512)).toStrictEqual({ kind: "none-recorded" });
  });
});

describe("the truncation notice", () => {
  it("states both byte figures when the payload recorded the original size", () => {
    const { container } = render(
      <TruncationNotice storedBody={STORED_PREFIX} preTruncationLength={4096} />,
    );
    expect(container.textContent).toContain("Truncated when recorded");
    // `\s` rather than a space: `Intl` separates a quantity from its unit with a narrow
    // no-break space.
    expect(container.textContent).toMatch(/61\sB of 4\.0\sKiB/u);
  });

  it("says the size was not recorded rather than computing one from the prefix", () => {
    const { container } = render(
      <TruncationNotice storedBody={STORED_PREFIX} preTruncationLength={undefined} />,
    );
    expect(container.textContent).toContain("the original size was not recorded");
  });

  it("names the declared loss the contract spells, never a phrase of its own", () => {
    const { container } = render(
      <TruncationNotice storedBody={STORED_PREFIX} preTruncationLength={4096} />,
    );
    expect(container.textContent).toContain("turn_content_truncated");
    expect(STORED_PREFIX_BYTES).toBeGreaterThan(0);
  });
});
