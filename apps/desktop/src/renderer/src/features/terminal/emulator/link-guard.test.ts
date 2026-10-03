// Which links a terminal may open, driven with the strings an attack would use. A pure rule,
// so the cases call it directly rather than dispatch a mouse event.

import { describe, expect, it } from "vitest";

import { allowedTerminalLinkHref } from "./link-guard.js";

describe("the link scheme guard", () => {
  it("refuses the schemes a program can print to attack the terminal that renders it", () => {
    // Printed text is attacker-controlled whenever the process is.
    expect(allowedTerminalLinkHref("javascript:alert(1)")).toBeUndefined();
    expect(allowedTerminalLinkHref("file:///etc/passwd")).toBeUndefined();
    expect(allowedTerminalLinkHref("data:text/html,<script>x</script>")).toBeUndefined();
  });

  it("refuses an unparseable string rather than passing it through", () => {
    // A guard that only checked for a banned prefix would let this reach an opener.
    expect(allowedTerminalLinkHref("not a url at all")).toBeUndefined();
    expect(allowedTerminalLinkHref("")).toBeUndefined();
  });
});
