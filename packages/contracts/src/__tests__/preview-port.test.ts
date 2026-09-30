// A shared port's web address carries a one-time ticket the machine trades for a cookie, so the
// address is only ever https: the ticket must never cross the network in the clear.
import { describe, expect, it } from "vitest";

import { PreviewPortTicketIssueResponseSchema } from "../preview-port.js";

describe("shared ports", () => {
  it("answers a ticket address only over https", () => {
    const secure = { address: "https://5173-mac-mini.relay.example/?ticket=abc" };
    const plain = { address: "http://5173-mac-mini.relay.example/?ticket=abc" };
    expect(PreviewPortTicketIssueResponseSchema.safeParse(secure).success).toBe(true);
    expect(PreviewPortTicketIssueResponseSchema.safeParse(plain).success).toBe(false);
  });
});
