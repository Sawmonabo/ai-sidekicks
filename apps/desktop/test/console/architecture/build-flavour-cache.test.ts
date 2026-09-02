// Which build flavour is on disk is whichever task ran last — and that holds
// only if a task reported as having run actually ran. The mechanism, the failure
// it was measured causing, and the foil are on the constant below.
//
// This is a claim about configuration rather than about source text, so it is
// read out of Turborepo's own resolution rather than asserted about a file.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");

/**
 * The three tasks that write `apps/desktop/out/**`, and one foil that does not.
 *
 * `build`, `build:smoke`, and `build:fixtures` produce the same directory and
 * differ in the `define` that decides what the console talks to. They are all
 * `cache: false`, and the reason is a measured one rather than a preference: a
 * Turborepo cache HIT restores the files it saved without emptying the directory
 * first, while a real `electron-vite build` empties it, so a restore layered over
 * a sibling flavour's output leaves that sibling's content-hashed chunks behind
 * beside the restored ones. Observed 2026-09-02 as `test:console-bundle`
 * replaying a cached `build` over a fixtures tree, where
 * `release-absence.test.ts` found the fixture tripwire handle in the orphaned
 * chunk. That tier only catches it when the tree happens to be dirty — a fresh CI
 * checkout never is — so the configuration is pinned here instead.
 *
 * The contracts package's own `build` is the foil: it writes its own directory,
 * shares it with nothing, and stays cacheable. Without it a reader that returned
 * `false` for every task would pass.
 */
const OUTPUT_DIRECTORY_SHARING_TASK_IDS: readonly string[] = [
  "@ai-sidekicks/desktop#build",
  "@ai-sidekicks/desktop#build:smoke",
  "@ai-sidekicks/desktop#build:fixtures",
];
const CACHEABLE_FOIL_TASK_ID = "@ai-sidekicks/contracts#build";

interface TurboDryRun {
  readonly tasks: readonly {
    readonly taskId: string;
    readonly resolvedTaskDefinition: { readonly cache: boolean };
  }[];
}

/**
 * Turborepo's own resolution of the three build tasks, read rather than parsed.
 *
 * `turbo.json` is JSONC and this package ships no JSONC parser; writing one to
 * read three booleans would be a parser of our own disagreeing with the tool's on
 * the day they differ. `--dry=json` resolves the real task graph — inheritance
 * from the root config included — and executes nothing.
 */
function resolveTurboCacheFlags(): ReadonlyMap<string, boolean> {
  const dryRun = spawnSync(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      "build",
      "build:smoke",
      "build:fixtures",
      "--filter=@ai-sidekicks/desktop",
      "--dry=json",
    ],
    { cwd: PACKAGE_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (dryRun.status !== 0) {
    throw new Error(
      `turbo --dry=json exited ${String(dryRun.status)}: ${dryRun.stderr || dryRun.stdout}`,
    );
  }
  let parsed: TurboDryRun;
  try {
    parsed = JSON.parse(dryRun.stdout) as TurboDryRun;
  } catch (parseError) {
    throw new Error(`turbo --dry=json did not emit JSON: ${dryRun.stdout.slice(0, 400)}`, {
      cause: parseError,
    });
  }
  return new Map(
    parsed.tasks.map((task) => [task.taskId, task.resolvedTaskDefinition.cache] as const),
  );
}

describe("the three build flavours cannot be restored over one another", () => {
  const cacheFlags = resolveTurboCacheFlags();

  it("resolves the tasks it is about", () => {
    for (const taskId of [...OUTPUT_DIRECTORY_SHARING_TASK_IDS, CACHEABLE_FOIL_TASK_ID]) {
      expect(cacheFlags.has(taskId), `${taskId} absent from the resolved graph`).toBe(true);
    }
  });

  it("leaves every task that writes `out/**` uncacheable", () => {
    const cacheable = OUTPUT_DIRECTORY_SHARING_TASK_IDS.filter(
      (taskId) => cacheFlags.get(taskId) !== false,
    );
    expect(
      cacheable,
      "a cached restore does not empty `out/**` first, so it layers over whichever flavour ran " +
        "last and leaves that one's content-hashed chunks in the tree",
    ).toStrictEqual([]);
  });

  it("negative control: a task that shares no output directory stays cacheable", () => {
    // Without this the check above passes over a reader that answers `false` for
    // everything, including a task nobody made uncacheable.
    expect(cacheFlags.get(CACHEABLE_FOIL_TASK_ID)).toBe(true);
  });
});
