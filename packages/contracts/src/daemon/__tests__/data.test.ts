// A data export streams its progress to Settings › Runtime and the command line; a running
// export never counts more sessions exported than it has in total.
import { describe, it } from "vitest";

import { DAEMON_DATA_METHOD_DESCRIPTORS } from "../data.js";
import { accepts, refuses } from "../../__tests__/safe-parse.test-support.js";

const JOB_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("daemon.dataExport and its progress stream", () => {
  const exportMethod = DAEMON_DATA_METHOD_DESCRIPTORS["daemon.dataExport"];
  const progressMethod = DAEMON_DATA_METHOD_DESCRIPTORS["daemon.dataExportSubscribe"];

  it("starts a job into a folder and streams its progress", () => {
    accepts(exportMethod.requestSchema, { destination: "/Users/me/sidekicks-export-2026-09-29" });
    accepts(exportMethod.responseSchema, { jobId: JOB_ID });
    accepts(progressMethod.requestSchema, { jobId: JOB_ID });
    accepts(progressMethod.emissionSchema, {
      state: "running",
      sessionsExported: 312,
      sessionsTotal: 1204,
    });
    accepts(progressMethod.emissionSchema, {
      state: "completed",
      path: "/Users/me/sidekicks-export-2026-09-29",
      totalBytes: 1_200_000_000,
    });
    accepts(progressMethod.emissionSchema, { state: "failed", message: "The disk is full." });
  });

  it("refuses progress that counts past its total, or an unknown state", () => {
    refuses(progressMethod.emissionSchema, {
      state: "running",
      sessionsExported: 1205,
      sessionsTotal: 1204,
    });
    refuses(progressMethod.emissionSchema, { state: "paused" });
  });
});
