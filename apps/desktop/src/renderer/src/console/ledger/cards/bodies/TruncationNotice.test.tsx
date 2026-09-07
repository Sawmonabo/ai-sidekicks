// What a truncated body says about the part that is not here.
//
// TWO CLAIMS, DRIVEN APART. The gate is a fact about this build's wires and is read
// off the growth ledger, so it is asserted against that ledger rather than against a
// boolean this suite writes down. The disposition is a decision over the gate and two
// recorded lengths, and it takes the gate as an argument — which is what lets all
// three arms run without any case mutating a frozen ledger row.
//
// THE ARM THIS BUILD ALWAYS REACHES IS THE NEGATIVE ONE, and it is the one that had
// to be said out loud: before this, a reader met "Truncated when recorded" and had no
// way to tell whether the rest was one press away or nowhere at all.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  RECOVERABLE_TRUNCATION_SLATE_ROW,
  TruncationNotice,
  isTruncatedRemainderRecoverable,
  truncatedRemainderDisposition,
} from "./TruncationNotice.js";

const STORED_PREFIX = "The tool wrote a great deal and this is the first part of it.";
const STORED_PREFIX_BYTES = STORED_PREFIX.length;

describe("whether a truncated body's remainder can be had", () => {
  it("is gated on the slate row that owns the read, which is unregistered", () => {
    expect(RECOVERABLE_TRUNCATION_SLATE_ROW.id).toBe("hydrated-event-read");
    expect(RECOVERABLE_TRUNCATION_SLATE_ROW.wireRegistered).toBe(false);
    expect(isTruncatedRemainderRecoverable()).toBe(false);
  });

  it("says the remainder is not carried while the read is unregistered", () => {
    // Whatever the payload recorded: with no read to make, how much was truncated
    // decides nothing a reader could act on.
    expect(truncatedRemainderDisposition(false, 10, 4096)).toStrictEqual({
      kind: "not-carried",
    });
    expect(truncatedRemainderDisposition(false, 10, undefined)).toStrictEqual({
      kind: "not-carried",
    });
  });

  it("names the remainder once the read exists and a length was recorded", () => {
    expect(truncatedRemainderDisposition(true, 1024, 4096)).toStrictEqual({
      kind: "claimable",
      remainderByteCount: 3072,
    });
  });

  it("has nothing to ask for when no pre-truncation length was recorded", () => {
    expect(truncatedRemainderDisposition(true, 1024, undefined)).toStrictEqual({
      kind: "none-recorded",
    });
  });

  it("has nothing to ask for when the recorded length does not exceed the prefix", () => {
    // A fetch that returned zero further bytes would report work that did not happen.
    expect(truncatedRemainderDisposition(true, 1024, 1024)).toStrictEqual({
      kind: "none-recorded",
    });
    expect(truncatedRemainderDisposition(true, 1024, 512)).toStrictEqual({
      kind: "none-recorded",
    });
  });
});

describe("the truncation notice", () => {
  it("states both byte figures when the payload recorded the original size", () => {
    const { container } = render(
      <TruncationNotice storedBody={STORED_PREFIX} preTruncationLength={4096} />,
    );
    expect(container.textContent).toContain("Truncated when recorded");
    // `\s` rather than a literal space: `Intl` separates a quantity from its unit
    // with a narrow no-break space, and asserting the typed one would pass only on
    // the locale that happens to use it.
    expect(container.textContent).toMatch(/61\sB of 4\.0\sKiB/u);
  });

  it("says the size was not recorded rather than computing one from the prefix", () => {
    const { container } = render(
      <TruncationNotice storedBody={STORED_PREFIX} preTruncationLength={undefined} />,
    );
    expect(container.textContent).toContain("the original size was not recorded");
  });

  it("tells a reader the rest is not carried, and offers nothing", () => {
    const { container } = render(
      <TruncationNotice storedBody={STORED_PREFIX} preTruncationLength={4096} />,
    );
    expect(container.textContent).toContain("The rest of it is not carried to this window.");
    expect(container.querySelector(".meridian-truncation-notice__show-all")).toBeNull();
  });

  it("offers no control even when a caller supplies a handler", () => {
    // The negative control for the gate: a control rendered on the handler alone
    // would be offering a fetch this build cannot make.
    const { container } = render(
      <TruncationNotice
        storedBody={STORED_PREFIX}
        preTruncationLength={4096}
        onShowAll={() => undefined}
      />,
    );
    expect(container.querySelector(".meridian-truncation-notice__show-all")).toBeNull();
  });

  it("names the declared loss the contract spells, never a phrase of its own", () => {
    const { container } = render(
      <TruncationNotice storedBody={STORED_PREFIX} preTruncationLength={4096} />,
    );
    expect(container.textContent).toContain("turn_content_truncated");
    expect(STORED_PREFIX_BYTES).toBeGreaterThan(0);
  });
});
