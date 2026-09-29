// The shared ports as every device and the machine parse them: a port number, and a
// web address that is only ever https.
import { describe, expect, it } from "vitest";

import { PreviewPortRequestSchema, PreviewPortTicketIssueResponseSchema } from "../preview-port.js";

describe("shared ports", () => {
  it("takes a port number and refuses what is not one", () => {
    expect(PreviewPortRequestSchema.safeParse({ port: 5173 }).success).toBe(true);
    for (const port of [0, 65536, 5173.5, "5173"]) {
      expect(PreviewPortRequestSchema.safeParse({ port }).success).toBe(false);
    }
  });

  it("answers a ticket address only over https", () => {
    const secure = { address: "https://5173-mac-mini.relay.example/?ticket=abc" };
    const plain = { address: "http://5173-mac-mini.relay.example/?ticket=abc" };
    expect(PreviewPortTicketIssueResponseSchema.safeParse(secure).success).toBe(true);
    expect(PreviewPortTicketIssueResponseSchema.safeParse(plain).success).toBe(false);
  });
});
