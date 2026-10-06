// `driver.subscribeEvents` streams one run's driver activity, and the client validates each frame
// against `DriverEventSchema`, which must refuse every other session event.

import { describe, expect, it } from "vitest";

import { DriverEventSchema } from "../event.js";
import { SessionEventSchema } from "../../../event/session.js";
import {
  buildAssistantMessageEvent,
  buildSessionCreatedEvent,
} from "../../../event/__tests__/session.test-support.js";

// One driver-category fixture and one non-driver one: the minimum that separates "refuses
// non-driver events" from "refuses everything".
describe("DriverEvent", () => {
  it("DriverEventSchema accepts a driver event", () => {
    const parsed = DriverEventSchema.safeParse(buildAssistantMessageEvent());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(buildAssistantMessageEvent());
  });

  it("DriverEventSchema REFUSES a schema-valid non-driver session event", () => {
    const nonDriver = buildSessionCreatedEvent();
    // Premise: without it the refusal below could be any parse failure.
    expect(SessionEventSchema.safeParse(nonDriver).success).toBe(true);

    const parsed = DriverEventSchema.safeParse(nonDriver);
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues).toEqual([
      expect.objectContaining({ path: ["type"] }),
    ]);
  });
});
