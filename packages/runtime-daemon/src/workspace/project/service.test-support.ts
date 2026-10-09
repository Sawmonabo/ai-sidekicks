// A project writer over a scratch database, for the tests that attach projects: its records on the
// read-only connection, the real branch-pattern check, a macOS-style folder place and a session
// archive that refuses, since attaching archives nothing.

import type { DatabaseConnections } from "../../database/connection/lifecycle.js";
import { findBranchPatternRefusal } from "../../git/branch-name-pattern.js";
import { createFolderPlace } from "../folder/place.js";
import type { RepoMountService } from "../repo/mount-service.js";
import { ProjectRecords } from "./records.js";
import { ProjectService } from "./service.js";

/** What a test project writer is built over. */
export interface TestProjectServiceInput {
  readonly database: DatabaseConnections;
  readonly mounts: Pick<RepoMountService, "resolveAttachTarget" | "insertAttachedMount" | "detach">;
  /** The worktrees folder a new slug must not reuse. */
  readonly worktreesDirectory: string;
  /** Receives each service-log line. */
  readonly serviceLogLines?: string[];
}

/** A project writer and the records it reads through. */
export interface TestProjectService {
  readonly projects: ProjectService;
  readonly records: ProjectRecords;
}

/** Builds a project writer over the scratch database. */
export function buildTestProjectService(input: TestProjectServiceInput): TestProjectService {
  const folderPlace = createFolderPlace({
    platform: "darwin",
    wslDistributionName: null,
    windowsDriveMounts: [],
  });
  const records = new ProjectRecords(input.database.reader, folderPlace);
  const projects = new ProjectService({
    writer: input.database.writer,
    records,
    mounts: input.mounts,
    sessions: {
      archiveOfForgottenProject: () => Promise.reject(new Error("this test archives no session")),
    },
    findBranchPatternRefusal,
    folderPlace,
    worktreesDirectory: input.worktreesDirectory,
    onProjectsChanged: () => undefined,
    writeServiceLog: (line) => {
      input.serviceLogLines?.push(line);
    },
  });
  return { projects, records };
}
