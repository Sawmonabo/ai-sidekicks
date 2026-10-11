import { describe, it } from "vitest";

import { LINUX_PROCESS_PEAK_READER } from "../linux.js";
import { expectPeakOfLiveChild } from "./contract.test-support.js";

describe.skipIf(process.platform !== "linux")("Linux's peak memory read", () => {
  it("reads a live child's peak past what it touched, and nothing once it ends", async () => {
    await expectPeakOfLiveChild(LINUX_PROCESS_PEAK_READER);
  });
});
