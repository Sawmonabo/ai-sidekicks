// What the version banner says BEYOND its code and its remedy.
//
// The rule that decides WHEN it is raised is `version-banner.test.tsx`; these cases are
// about the surface itself, because the two fail differently: a rule that is wrong
// marks the wrong window, and a supplement that is wrong marks the right window with a
// pair that names one side of a disagreement, or none.
//
// AND THE CODE AND THE REMEDY ARE NO LONGER THIS COMPONENT'S. They ride the frame's own
// banner list now, so a refusal is announced once through the announcer every other
// banner goes through — which means the cases that used to read them off
// `.meridian-refusal--banner` here read them off the composed window in
// `version-banner.test.tsx` instead, beside the case that pins there being exactly ONE
// of those elements. Asserting them here as well would only prove this component can
// draw a second copy.
//
// There is no case here for a healthy window, and that absence is the point: this
// component takes a mismatch and nothing else, so a window whose handshake succeeded
// cannot be handed to it. The claim that such a window renders no element at all is a
// FRAME claim, and the frame is where it is asserted.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { VersionBanner } from "./VersionBanner.js";
import type { ConsoleVersionMismatch } from "./version-banner.js";

const BELOW_FLOOR: ConsoleVersionMismatch = {
  reason: "version.floor_exceeded",
  consoleProtocolVersion: "2026-05-01",
  daemonProtocolVersion: "2026-09-01",
  daemonSupportedProtocols: ["2026-09-01"],
  movingSide: "console",
  remedy: "Update the console. Reads carry on meanwhile.",
};

const ABOVE_CEILING: ConsoleVersionMismatch = {
  reason: "version.ceiling_exceeded",
  consoleProtocolVersion: "2026-09-01",
  daemonProtocolVersion: "2026-05-01",
  daemonSupportedProtocols: ["2026-05-01", "2026-05-14"],
  movingSide: "runtime",
  remedy: "Update the local runtime. Reads carry on meanwhile.",
};

/** The one refusal the daemon answers with no supported set. */
const SECOND_HANDSHAKE: ConsoleVersionMismatch = {
  reason: "protocol.handshake_already_completed",
  consoleProtocolVersion: "2026-05-01",
  daemonProtocolVersion: "2026-05-01",
  daemonSupportedProtocols: undefined,
  movingSide: "neither",
  remedy: "Neither version is out of range. Reads carry on meanwhile.",
};

afterEach(() => {
  cleanup();
});

describe("the version banner — collapsed to the pair", () => {
  it("names both versions and says which side each belongs to", () => {
    render(<VersionBanner mismatch={BELOW_FLOOR} />);

    const pair = screen.getByRole("note");
    expect(pair.textContent).toContain("2026-05-01");
    expect(pair.textContent).toContain("2026-09-01");
    expect(pair.textContent).toContain("local runtime");
  });

  it("draws no refusal of its own, so the frame's banner is the only one on screen", () => {
    const { container } = render(<VersionBanner mismatch={BELOW_FLOOR} />);

    // The defect this pins: while this component drew its own `RefusalBanner`, the
    // code and the remedy were on screen twice — once here and once in the frame's
    // banner list — and announced once, by the list. Neither the code nor the
    // sentence belongs to this surface any more.
    expect(container.querySelector(".meridian-refusal--banner")).toBeNull();
    expect(container.textContent).not.toContain("version.floor_exceeded");
    expect(container.textContent).not.toContain("Update the console");
  });

  it("offers no remedy control, because neither move happens here", () => {
    render(<VersionBanner mismatch={ABOVE_CEILING} />);

    // No link: updating either build happens outside this window, and a control here
    // would be the banner executing a remedy it is only allowed to name.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("negative control: it renders the versions it is given and not a fixed pair", () => {
    // Without this, a banner that hard-coded one build's version would satisfy the
    // first case and would misreport every other install it ever ran on.
    render(<VersionBanner mismatch={ABOVE_CEILING} />);

    const pair = screen.getByRole("note");
    expect(pair.textContent).toContain("2026-09-01");
    expect(pair.textContent).toContain("2026-05-01");
  });
});

describe("the version banner — the supported set, one click away", () => {
  it("keeps the runtime's full set off the collapsed line and inside the disclosure", () => {
    render(<VersionBanner mismatch={ABOVE_CEILING} />);

    // The collapsed line carries the pair and not the set — the density claim. The
    // set is in the document, inside a closed `<details>`, which is what "one click
    // away" means for a native disclosure.
    expect(screen.getByRole("note").textContent).not.toContain("2026-05-14");
    expect(screen.getByText("2026-05-14")).toBeDefined();
  });

  it("says the runtime published no set rather than drawing an empty one", () => {
    render(<VersionBanner mismatch={SECOND_HANDSHAKE} />);

    // Not an empty list. A runtime that listed nothing has said nothing about which
    // versions it speaks, and an empty list would say it speaks none — the two facts
    // the reading keeps apart, kept apart here too.
    expect(screen.getByText("The local runtime published no supported-version set.")).toBeDefined();
    expect(document.querySelector(".meridian-version-banner__set")).toBeNull();
  });

  it("negative control: a refusal that DID publish a set draws the list and not the sentence", () => {
    // Without this, a disclosure that rendered the absence sentence unconditionally
    // would pass the case above while hiding every set a runtime ever published.
    render(<VersionBanner mismatch={BELOW_FLOOR} />);

    expect(screen.queryByText("The local runtime published no supported-version set.")).toBeNull();
    expect(document.querySelectorAll(".meridian-version-banner__set li")).toHaveLength(1);
  });
});
