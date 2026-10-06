// The `session.subscribe` frame: a batch of changes with no frame cursor, or the caught-up frame
// (no changes, the drop mark, the newest cursor). Any other combination would leave the client
// without a position to resume from.
import { describe, expect, it } from "vitest";

import { SessionEventSchema } from "../../event/session.js";
import { SessionStreamFrameSchema } from "../methods.js";
import { buildSessionCreatedEvent } from "../../event/__tests__/session.test-support.js";

describe("SessionStreamFrameSchema (each `session.subscribe` notify's value)", () => {
  const FrameSchema = SessionStreamFrameSchema(SessionEventSchema);
  const event = buildSessionCreatedEvent();
  const change = (cursor: string): { cursor: string; event: typeof event } => ({ cursor, event });

  it("accepts a batch carrying the drop mark", () => {
    expect(FrameSchema.safeParse({ changes: [change("c-9")], dropped: true }).success).toBe(true);
  });

  it("accepts the caught-up frame: no changes, the drop mark and the newest cursor", () => {
    expect(FrameSchema.safeParse({ changes: [], dropped: true, cursor: "c-9" }).success).toBe(true);
  });

  it("refuses an empty frame without the drop mark and the newest cursor", () => {
    expect(FrameSchema.safeParse({ changes: [] }).success).toBe(false);
    expect(FrameSchema.safeParse({ changes: [], dropped: true }).success).toBe(false);
    expect(FrameSchema.safeParse({ changes: [], cursor: "c-9" }).success).toBe(false);
  });

  it("refuses a frame cursor beside changes", () => {
    expect(
      FrameSchema.safeParse({ changes: [change("c-1")], dropped: true, cursor: "c-1" }).success,
    ).toBe(false);
  });
});
