// A push crosses from the machine to the control plane and on to Apple, Google or a browser's
// push service, so the sealed notice is bounded by its decoded bytes before it leaves the machine.
import { describe, expect, it } from "vitest";

import { PushSendRequestSchema } from "../push.js";

const request = {
  deviceId: "device-phone-1",
  sealed: Buffer.alloc(1392, 9).toString("base64"),
  collapseId: Buffer.alloc(16, 1).toString("base64url"),
  urgency: "high",
  expiresAt: "2026-09-13T10:00:00.000Z",
};

describe("push.send", () => {
  it("accepts a sealed notice for one device", () => {
    expect(PushSendRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses a notice past every platform's 4 KB limit", () => {
    expect(
      PushSendRequestSchema.safeParse({
        ...request,
        sealed: Buffer.alloc(4097, 9).toString("base64"),
      }).success,
    ).toBe(false);
  });
});
