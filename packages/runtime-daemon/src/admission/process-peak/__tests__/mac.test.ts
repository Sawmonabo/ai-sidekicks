import { describe, it } from "vitest";

import { MAC_PROCESS_PEAK_READER } from "../mac.js";
import { expectPeakOfLiveChild } from "./contract.test-support.js";

describe.skipIf(process.platform !== "darwin")("macOS's peak memory read", () => {
  it("reads a live child's peak past what it touched, and nothing once it ends", async () => {
    await expectPeakOfLiveChild(MAC_PROCESS_PEAK_READER);
  });
});
