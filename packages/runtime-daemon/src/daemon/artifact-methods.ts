// Builds the artifact store over the daemon's one database and binds the `artifact.*` calls it
// answers: the three ingest calls and the publish. The store sits in the data folder: the
// content-addressed payloads in `objects/` and the spools of ingests and publishes beside them in
// `spool/`, on one volume, so a spool moves into the store by a rename. Its start schedules the
// ingest reaper on the service's one scheduler: a pass at once, which clears the spools a stopped
// daemon left, then one every ten minutes.

import * as path from "node:path";

import { DAEMON_DATA_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon/data";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";

import { AttachmentIngestService } from "../artifacts/ingest/service.js";
import { IngestValidation } from "../artifacts/ingest/validation.js";
import { PayloadStore } from "../artifacts/payload-store.js";
import { ArtifactPublishService } from "../artifacts/publish.js";
import type { DatabaseConnections } from "../database/connection/lifecycle.js";
import { registerArtifactIngestMethods } from "../ipc/handlers/artifact/ingest.js";
import { registerArtifactPublish } from "../ipc/handlers/artifact/publish.js";
import type { RepeatingJob, ScheduledJobHandle } from "./scheduler.js";

const ARTIFACTS_FOLDER_NAME = "artifacts";

// How often the reaper looks for streams past their lifetime and spools gone unwritten: often
// enough that a stream is ended within minutes of its 6-hour lifetime.
const INGEST_REAPER_INTERVAL_MS = 10 * 60 * 1000;

/** What the artifact store is built from. */
export interface ArtifactMethodsDeps {
  readonly database: DatabaseConnections;
  /** The person's home folder; the store lives in the data folder inside it. */
  readonly homeDirectory: string;
  /** The service's one scheduler, which the reaper runs on. */
  readonly scheduler: { scheduleRepeating(job: RepeatingJob): ScheduledJobHandle };
  /** Reads the free bytes on the volume holding a folder. */
  readonly readVolumeFreeBytes: (folderPath: string) => Promise<number>;
}

/** The artifact store's background work. */
export interface ArtifactMethods {
  /** Schedules the ingest reaper; called once, after the daemon's recovery pass has ended. */
  readonly start: () => void;
  /** Cancels the reaper's future passes; a pass under way finishes. */
  readonly stop: () => void;
}

/** Builds the artifact store and registers its calls on `registry`. */
export function registerArtifactMethods(
  registry: MethodRegistry,
  deps: ArtifactMethodsDeps,
): ArtifactMethods {
  const storeDirectory = path.join(
    deps.homeDirectory,
    DAEMON_DATA_FOLDER_NAME,
    ARTIFACTS_FOLDER_NAME,
  );
  const payloadStore = new PayloadStore(path.join(storeDirectory, "objects"));
  const validation = new IngestValidation({ payloadStore });
  const spoolDirectory = path.join(storeDirectory, "spool");
  const ingest = new AttachmentIngestService({
    database: deps.database,
    validation,
    spoolDirectory,
    readVolumeFreeBytes: deps.readVolumeFreeBytes,
  });
  registerArtifactIngestMethods(registry, ingest);
  const publisher = new ArtifactPublishService({
    database: deps.database,
    validation,
    payloadStore,
    spoolDirectory,
  });
  registerArtifactPublish(registry, publisher);

  let reaperTick: ScheduledJobHandle | undefined;
  return {
    start: () => {
      reaperTick = deps.scheduler.scheduleRepeating({
        name: "ingest reaper",
        intervalMs: INGEST_REAPER_INTERVAL_MS,
        run: () => ingest.reap(),
      });
    },
    stop: () => {
      reaperTick?.cancel();
    },
  };
}
