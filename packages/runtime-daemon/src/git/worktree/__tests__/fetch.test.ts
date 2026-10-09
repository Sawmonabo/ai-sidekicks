// The background fetch on real git: it lists the repository's remotes and fetches each one on its
// own with `--no-write-fetch-head`, never `--all`, whose fetches of each remote an older git runs
// without that flag, writing `FETCH_HEAD` without bound.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { createStreamedGitRunner } from "../../../workspace/clone/streamed-git.js";
import {
  createGitCommand,
  createGitRunner,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
} from "../../process.js";
import { BackgroundFetch } from "../fetch.js";

let folder: string;
let scratch: ScratchDatabase;

beforeEach(async () => {
  folder = mkdtempSync(path.join(tmpdir(), "aisk-fetch-"));
  scratch = await openScratchDatabase();
});

afterEach(async () => {
  await scratch.close();
  rmSync(folder, { recursive: true, force: true });
});

describe("the background fetch", () => {
  it("lists the remotes, then fetches each one alone without writing FETCH_HEAD", async () => {
    const source = path.join(folder, "source");
    const repository = path.join(folder, "repository");
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", source]);
    execFileSync("git", [
      "-C",
      source,
      "-c",
      "user.name=Ana",
      "-c",
      "user.email=ana@example.com",
      "commit",
      "--quiet",
      "--allow-empty",
      "--message=first",
    ]);
    execFileSync("git", ["clone", "--quiet", source, repository]);
    execFileSync("git", ["-C", repository, "remote", "add", "upstream", source]);
    // A git that writes each run's arguments down, then runs the real git.
    const argumentLog = path.join(folder, "git-arguments");
    const recordingGit = path.join(folder, "recording-git");
    writeFileSync(
      recordingGit,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argumentLog}'\nexec git "$@"\n`,
    );
    chmodSync(recordingGit, 0o755);
    const serviceLogLines: string[] = [];
    const nextFetchScheduled = Promise.withResolvers<void>();
    const backgroundFetch = new BackgroundFetch({
      scheduler: {
        schedule: () => {
          nextFetchScheduled.resolve();
          return { cancel: () => undefined };
        },
      },
      database: scratch,
      writeServiceLog: (line) => {
        serviceLogLines.push(line);
      },
      git: createGitCommand({
        git: createGitRunner(recordingGit),
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      }),
      streamedGit: createStreamedGitRunner(recordingGit),
    });

    const release = backgroundFetch.keepFresh({ repoMountId: "mount", repositoryRoot: repository });
    await nextFetchScheduled.promise;
    release();
    await backgroundFetch.stop();

    const fetchOptions = "--no-prune --no-prune-tags --no-write-fetch-head --quiet --";
    expect(readFileSync(argumentLog, "utf8").trim().split("\n")).toEqual([
      `-C ${repository} remote`,
      `-C ${repository} fetch ${fetchOptions} origin`,
      `-C ${repository} fetch ${fetchOptions} upstream`,
    ]);
    expect(serviceLogLines).toEqual([]);
  });
});
