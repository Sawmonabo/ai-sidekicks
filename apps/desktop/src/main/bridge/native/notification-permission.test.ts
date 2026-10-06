// Each authorization the operating system reports reaches the page as its own state: not being
// asked yet never folds onto a refusal, and a process the system cannot read says `unsupported`.

import { getNotificationStatus } from "notify-status";
import { describe, expect, it } from "vitest";

import { readNotificationPermission } from "./notification-permission.js";

describe("the notification permission", () => {
  it("keeps each of the four authorizations apart", async () => {
    const states = [];
    for (const authorization of ["granted", "denied", "notDetermined", "unsupported"] as const) {
      states.push(
        await readNotificationPermission(() =>
          Promise.resolve({ authorization, doNotDisturb: false, platform: "darwin" }),
        ),
      );
    }

    expect(states).toStrictEqual([
      { state: "granted" },
      { state: "denied" },
      { state: "not-determined" },
      { state: "unsupported" },
    ]);
  });

  it("reads `unsupported` through the real reader in a process with no app bundle", async () => {
    // A test runner has no bundle id on macOS and no reader at all on Linux.
    await expect(readNotificationPermission(getNotificationStatus)).resolves.toStrictEqual({
      state: "unsupported",
    });
  });
});
