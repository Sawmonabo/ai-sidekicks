// Which links a terminal may open, driven with the strings an attack would use. A pure rule,
// so the cases call it directly rather than dispatch a mouse event.

import { describe, expect, it } from "vitest";

import { TERMINAL_LINK_SCHEMES, allowedTerminalLinkHref } from "./link-guard.js";

describe("the link scheme guard", () => {
  it("closes the allow-list at the two schemes a terminal link may open", () => {
    expect([...TERMINAL_LINK_SCHEMES]).toStrictEqual(["http:", "https:"]);
  });

  it("passes an ordinary web link through, normalized", () => {
    expect(allowedTerminalLinkHref("https://example.test/a")).toBe("https://example.test/a");
    expect(allowedTerminalLinkHref("http://example.test")).toBe("http://example.test/");
  });

  it("refuses the schemes a program can print to attack the terminal that renders it", () => {
    // Printed text is attacker-controlled whenever the process is.
    expect(allowedTerminalLinkHref("javascript:alert(1)")).toBeUndefined();
    expect(allowedTerminalLinkHref("file:///etc/passwd")).toBeUndefined();
    expect(allowedTerminalLinkHref("data:text/html,<script>x</script>")).toBeUndefined();
  });

  it("negative control: an unparseable string is refused rather than passed through", () => {
    // A guard that only checked for a banned prefix would let this reach an opener.
    expect(allowedTerminalLinkHref("not a url at all")).toBeUndefined();
    expect(allowedTerminalLinkHref("")).toBeUndefined();
  });
});
