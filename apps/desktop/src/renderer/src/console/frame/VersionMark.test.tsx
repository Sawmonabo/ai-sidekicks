// What the mark says, and what the raised form adds to it.
//
// The rule that decides WHEN it renders is `version-mark.test.tsx`; these cases are
// about the surface itself, because the two fail differently: a rule that is wrong
// marks the wrong window, and a mark that is wrong marks the right window with a
// sentence that names one side of a disagreement, or none.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { VersionMark } from "./VersionMark.js";
import type { ConsoleVersionMark } from "./version-mark.js";

const AGREED_MARK: ConsoleVersionMark = {
  consoleProtocolVersion: "2026-05-01",
  daemonProtocolVersion: "2026-05-01",
  daemonSupportedProtocols: ["2026-05-01", "2026-09-01"],
  consoleProtocolIsSupported: true,
};

const REFUSED_MARK: ConsoleVersionMark = {
  consoleProtocolVersion: "2026-05-01",
  daemonProtocolVersion: "2026-09-01",
  daemonSupportedProtocols: ["2026-09-01"],
  consoleProtocolIsSupported: false,
};

afterEach(() => {
  cleanup();
});

describe("the version mark — collapsed to the pair", () => {
  it("names both versions and says which side each belongs to", () => {
    render(<VersionMark mark={AGREED_MARK} mismatch={undefined} />);

    const pair = screen.getByRole("note");
    expect(pair.textContent).toContain("2026-05-01");
    expect(pair.textContent).toContain("local runtime");
  });

  it("keeps the runtime's full supported set one click away rather than on the line", () => {
    render(<VersionMark mark={AGREED_MARK} mismatch={undefined} />);

    // The collapsed line carries the pair and not the set — the density claim. The
    // set is in the document, inside a closed `<details>`, which is what "one click
    // away" means for a native disclosure.
    expect(screen.getByRole("note").textContent).not.toContain("2026-09-01");
    expect(screen.getByText("2026-09-01")).toBeDefined();
    expect(
      screen.getByText("This console's protocol is one the local runtime supports."),
    ).toBeDefined();
  });

  it("raises no banner and offers no remedy control when the two builds met", () => {
    const { container } = render(<VersionMark mark={AGREED_MARK} mismatch={undefined} />);

    // Queried by the banner's own class rather than by role: a native `<details>`
    // carries the same implicit `group` role the banner does, so a role query here
    // would find the disclosure and pass whatever the banner did.
    expect(container.querySelector(".meridian-refusal--banner")).toBeNull();
    // Updating either build happens outside this window. A link here would be the
    // banner executing a remedy it is only allowed to name.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("negative control: it renders the versions it is given and not a fixed pair", () => {
    // Without this, a mark that hard-coded one build's version would satisfy the first
    // case and would misreport every other install it ever ran on.
    render(<VersionMark mark={REFUSED_MARK} mismatch={undefined} />);

    const pair = screen.getByRole("note");
    expect(pair.textContent).toContain("2026-09-01");
    expect(
      screen.getByText("This console's protocol is not in the set the local runtime published."),
    ).toBeDefined();
  });
});

describe("the version mark — raised as the mismatch banner", () => {
  it("carries the runtime's own reason as the code, and names the side that moves", () => {
    const { container } = render(
      <VersionMark
        mark={REFUSED_MARK}
        mismatch={{
          reason: "version.floor_exceeded",
          movingSide: "console",
          remedy: "Update the console. Reads carry on meanwhile.",
        }}
      />,
    );

    const banner = container.querySelector(".meridian-refusal--banner");
    // The code is the wire's, verbatim and in mono; the sentence around it is ours,
    // because the corpus registers the reason and writes no copy for it.
    expect(banner?.textContent).toContain("version.floor_exceeded");
    expect(banner?.textContent).toContain("Update the console");
    // The pair is still there. A banner that replaced it would tell a person the two
    // builds disagree without telling them which two.
    expect(screen.getByRole("note").textContent).toContain("2026-05-01");
  });

  it("is persistent: it offers no dismiss control, because the state has not gone away", () => {
    const { container } = render(
      <VersionMark
        mark={REFUSED_MARK}
        mismatch={{
          reason: "version.ceiling_exceeded",
          movingSide: "runtime",
          remedy: "Update the local runtime. Reads carry on meanwhile.",
        }}
      />,
    );

    expect(container.querySelector(".meridian-refusal--banner")).not.toBeNull();
    expect(container.querySelector(".meridian-refusal__dismiss")).toBeNull();
  });

  it("negative control: the banner is absent for the very same mark with no mismatch", () => {
    // Without this, a component that rendered the banner unconditionally would pass
    // every assertion above while putting a refusal across a window that is working.
    const { container } = render(<VersionMark mark={REFUSED_MARK} mismatch={undefined} />);

    expect(container.querySelector(".meridian-refusal--banner")).toBeNull();
    expect(screen.queryByText(/version\.floor_exceeded/)).toBeNull();
  });
});
