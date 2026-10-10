// The database file as a start opens it. A file a previous run found damaged is repaired first,
// while the socket answers that the service is repairing; one the repair cannot heal fails the
// start, naming why, and a stop during the repair ends the start, the file left for the next. The
// file's structural check then runs beside the service at every start but the first: after any
// end of the last run, clean or not, writes go at once, since nothing but a checkpoint the storage
// did not flush can damage the file, and the writer's checkpoints flush it; a file something else
// changed since the last run, or with no record of one, holds every write until the check finds
// it sound. A check that cannot run leaves the service taking writes and reading as degraded, and
// the file unvouched, so the next start checks before it writes again. Damage the check or any
// read or write meets is recorded beside the file and stops the daemon, so its next start repairs
// the file before anything opens it.

import type { DaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";

import {
  openDatabaseConnections,
  type DatabaseConnections,
} from "../database/connection/lifecycle.js";
import {
  DatabaseFileCheck,
  type DatabaseFileCheckAnswer,
} from "../recovery/database-file/check.js";
import {
  DatabaseDamageWatch,
  isDatabaseDamageError,
  recordDatabaseDamage,
} from "../recovery/database-file/damage.js";
import {
  forgetLastRun,
  readLastRunEnd,
  recordCleanStop,
  recordRunStart,
} from "../recovery/database-file/last-run.js";
import type { DatabaseFileOperatingSystem } from "../recovery/database-file/operating-system.js";
import { repairDatabaseFile } from "../recovery/database-file/repair.js";
import { answerRepairingWhile } from "./repairing-socket.js";
import { DaemonStartStoppedError } from "./start-stopped-error.js";

/** What a start needs to open the database file. */
export interface DatabaseFileOpenOptions {
  readonly databasePath: string;
  readonly dataFolder: string;
  readonly indexFolderPath: string;
  readonly runFolder: DaemonRunFolder;
  readonly operatingSystem: DatabaseFileOperatingSystem;
  /** The folder the person's backups go to; read only when the file is damaged. */
  readonly readBackupFolder: () => Promise<string>;
  /** Ends a repair under way when it aborts. */
  readonly stopSignal: AbortSignal;
  readonly now: () => Date;
  readonly writeServiceLog: (line: string) => void;
}

// How the start's check of the file ended: as the check answered, or it `failed` to run, or a new
// file was not checked (`not-run`).
type DatabaseFileCheckOutcome = DatabaseFileCheckAnswer["outcome"] | "failed" | "not-run";

/** The open database file, its damage watch and its check. */
export interface OpenedDatabaseFile {
  readonly database: DatabaseConnections;
  /** Learns of damage the check or any read or write meets. */
  readonly damageWatch: DatabaseDamageWatch;
  /** Resolves once the check has answered and its answer has been acted on. */
  readonly checkOutcome: Promise<DatabaseFileCheckOutcome>;
  /** Ends the check if it still runs; resolves once its answer has been acted on. */
  stopCheck(): Promise<DatabaseFileCheckOutcome>;
  /**
   * Records the clean stop, when the file is vouched for, by how the last run ended or by a sound
   * check; call only once every connection to the file has closed. Rejects with the file system's
   * error.
   */
  recordCleanStop(): Promise<void>;
  /**
   * Records the damage found, if any, beside the file, so the next start repairs it; resolves at
   * once when none was found, and every call shares one record. Rejects with the file system's
   * error, naming what the next start must do instead.
   */
  recordFoundDamage(): Promise<void>;
}

/**
 * Repairs the file when a run recorded damage to it, opens it and starts its check. Throws when
 * the file is damaged and could not be repaired, or is too damaged to open, which is recorded so
 * the next start repairs it, and `DaemonStartStoppedError` when a stop ended the repair.
 */
export async function openDatabaseFile(
  options: DatabaseFileOpenOptions,
): Promise<OpenedDatabaseFile> {
  const { databasePath, writeServiceLog } = options;
  // Before anything opens the file, so a repaired file replaces it whole.
  const fileRepair = await repairDatabaseFile({
    databasePath,
    dataFolder: options.dataFolder,
    indexFolderPath: options.indexFolderPath,
    operatingSystem: options.operatingSystem,
    readBackupFolder: options.readBackupFolder,
    whileRepairing: (repair) => answerRepairingWhile(options.runFolder, repair, writeServiceLog),
    stopSignal: options.stopSignal,
    now: options.now,
    writeServiceLog,
  });
  if (fileRepair.outcome === "stopped") {
    throw new DaemonStartStoppedError("repairing the database file");
  }
  // A file the repair could not heal is left as it is, never opened for writing, and the service
  // does not start: with no store it has nothing to serve.
  if (fileRepair.outcome === "unrepaired") {
    throw new Error(
      `The database file is damaged and could not be repaired: ${fileRepair.reason}. ` +
        `Its files are copied aside in ${fileRepair.asideFolder}`,
    );
  }
  const lastRunEnd = await readLastRunEnd(databasePath);
  let isVouched = false;
  // A run that ends uncleanly leaves this record, which vouches for the file at the next start;
  // an unvouched file keeps the last run's record until its check finds it sound.
  if (lastRunEnd !== "unknown") {
    await recordRunStart(databasePath);
    isVouched = true;
  } else {
    writeServiceLog(
      "The database file changed since the service's last run, or holds no record of one; " +
        "writes wait for the file's check",
    );
  }
  const writesHold = isVouched ? undefined : Promise.withResolvers<void>();
  const damageWatch = new DatabaseDamageWatch();
  const database = await openDatabaseRecordingDamage({
    databasePath,
    writeServiceLog,
    writesHeldUntil: writesHold?.promise,
    onWriteFailed: (error) => {
      damageWatch.report(error);
    },
  });
  // A new file has nothing to check. A check starts after the writer's open, which rebuilds a
  // crashed run's log index under locks the check's own open would be refused by.
  const fileCheck =
    lastRunEnd === "new-file"
      ? undefined
      : DatabaseFileCheck.start(databasePath, options.operatingSystem.sqliteShellProgram);
  const checkStartedAt = performance.now();
  const checkOutcome: Promise<DatabaseFileCheckOutcome> =
    fileCheck === undefined
      ? Promise.resolve("not-run")
      : fileCheck.answer.then(
          async (answer): Promise<DatabaseFileCheckOutcome> => {
            switch (answer.outcome) {
              case "sound": {
                const checkMs = Math.round(performance.now() - checkStartedAt);
                writeServiceLog(
                  `The database file's check found it sound in ${String(checkMs)} ms`,
                );
                if (!isVouched) {
                  try {
                    await recordRunStart(databasePath);
                    isVouched = true;
                  } catch (error) {
                    writeServiceLog(
                      "Recording that the file was found sound failed, so the next start " +
                        `checks it before it writes again: ${describeError(error)}`,
                    );
                  }
                }
                writesHold?.resolve();
                return "sound";
              }
              case "damaged":
                damageWatch.find(answer.damage);
                return "damaged";
              case "stopped":
                return "stopped";
            }
          },
          async (error: unknown): Promise<DatabaseFileCheckOutcome> => {
            writeServiceLog(
              `The database file could not be checked, so the service takes writes unchecked ` +
                `and its next start checks the file again: ${describeError(error)}`,
            );
            writesHold?.resolve();
            // A file the last run vouched for is vouched for no longer.
            if (isVouched) {
              isVouched = false;
              await forgetLastRun(databasePath).catch((forgetError: unknown) => {
                writeServiceLog(
                  "Removing the record of the last run failed, so the next start may write " +
                    `before its check answers: ${describeError(forgetError)}`,
                );
              });
            }
            return "failed";
          },
        );
  let damageRecord: Promise<void> | undefined;
  return {
    database,
    damageWatch,
    checkOutcome,
    stopCheck: () => {
      fileCheck?.stop();
      return checkOutcome;
    },
    recordCleanStop: async () => {
      if (isVouched) {
        await recordCleanStop(databasePath);
      }
    },
    recordFoundDamage: () => {
      if (!damageWatch.isFound) {
        return Promise.resolve();
      }
      damageRecord ??= damageWatch.whenFound.then(async (damage) => {
        try {
          await recordDatabaseDamage(databasePath, damage);
        } catch (error) {
          throw new Error(
            "Recording the damage to the database file failed, so the next start's check must " +
              `find it again: ${describeError(error)}`,
            { cause: error },
          );
        }
      });
      return damageRecord;
    },
  };
}

// Opens the database's connections; a file too damaged to open is recorded for the next start to
// repair, and the start fails naming it.
async function openDatabaseRecordingDamage(
  options: Parameters<typeof openDatabaseConnections>[0],
): Promise<DatabaseConnections> {
  try {
    return await openDatabaseConnections(options);
  } catch (error) {
    if (!isDatabaseDamageError(error)) {
      throw error;
    }
    await recordDatabaseDamage(options.databasePath, describeError(error));
    throw new Error(
      `The database file is damaged; the next start repairs it: ${describeError(error)}`,
      { cause: error },
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
