// The committed initial-graph census, and what to say when the build disagrees with it.
//
// WHY THE PIN IS A FILE AND NOT A LIST IN THE TEST. The census is ninety-nine owners and
// a thousand modules; a literal that size in a spec file is a spec file that is mostly
// data, and the thing a reviewer needs from it — WHICH module joined — is exactly what a
// thousand-line literal buries. As a JSON file beside the test it is a diff: the review
// that matters reads one added line, and the case beside it stays short enough to read
// as a case.
//
// AND WHY THE PIN IS THE WHOLE CENSUS AND NOT THE OWNER KEYS. Pinning the keys alone
// leaves a hole with a name: a lazy module that becomes eagerly reachable inside an owner
// ALREADY on the graph moves no key. `console/browser/pane` is on it for one registration
// module, so a second module from that directory — the pane body, its chrome, its view
// binding — arrives with the key set unchanged, the chunk names unchanged, and the byte
// budget next door still met. Every check in the tier stays green while the loader
// boundary the diet bought is gone. The membership claim has to be membership.
//
// ONE OWNER-QUALIFIED MODULE PER LINE, AND THE SHAPE IS THE DIFF'S. An owner-to-modules
// object is the same information, and Prettier — which gates this file like every other —
// collapses a short array onto one line, so adding one module to an owner that holds two
// rewrites the whole row and the reviewer reads a changed line rather than an added one.
// A flat sorted array of `<owner>/<module>` is broken one element per line at any length
// this census reaches, so a module that joins is one `+` line carrying its own owner, and
// sorting keeps an owner's entries contiguous.
//
// REGENERATION IS EXPLICIT, AND IT IS THE CONVENTION THIS PACKAGE ALREADY HAS.
// `UPDATE_SNAPSHOT` is the variable the console screenshot tier's committed references
// are regenerated through — `package.json`'s `test:console-screenshot` pins it to `none`
// and `.github/workflows/console-screenshot-baselines.yml` sets it to `all` for its
// regenerate mode — and it is Vitest's own, so a second variable here would be a second
// convention for one gesture. What is deliberately NOT adopted is Vitest's `new` mode:
// a run that mints a pin that is missing is a run that is green about a census nobody
// wrote down, so this file writes only under an explicit `all` and refuses a missing pin
// the way the census refuses a missing build.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Every module on the initial graph as `<owner>/<module>`, sorted and unique. */
export type InitialGraphPin = readonly string[];

/**
 * A pin that is absent, unparseable, or not shaped like a census.
 *
 * Its own class rather than a bare `Error`, so a case can assert that a planted pin was
 * refused for BEING unreadable and not because some later line happened to throw while
 * reading it — the distinction `RendererBundleOutputMissingError` draws next door.
 */
export class InitialGraphPinUnreadableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InitialGraphPinUnreadableError";
  }
}

/** The committed census, beside the case that reads it. */
export const INITIAL_GRAPH_PIN_PATH: string = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "initial-graph-census.pinned.json",
);

/** Vitest's own update-mode variable, and this package's regeneration door. */
const UPDATE_MODE_VARIABLE = "UPDATE_SNAPSHOT";

/** The one mode that rewrites a pin that already exists. */
const REWRITE_EVERY_PIN = "all";

/** What a reader is told to run when the census and the pin disagree deliberately. */
export const INITIAL_GRAPH_PIN_REGENERATION_COMMAND: string =
  `${UPDATE_MODE_VARIABLE}=${REWRITE_EVERY_PIN} pnpm exec vitest run ` +
  "--project=console-bundle test/console/budget/initial-graph-census.test.ts";

/** Whether this run was asked to rewrite the pin rather than check against it. */
export function initialGraphPinRewriteRequested(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment[UPDATE_MODE_VARIABLE] === REWRITE_EVERY_PIN;
}

/** Code-unit order, never `localeCompare` — `initial-graph-census.ts` says why. */
export function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** One owner's modules as the pin names them, so a census becomes a pin. */
export function initialGraphPinOf(
  modulesByOwner: ReadonlyMap<string, readonly string[]>,
): InitialGraphPin {
  return [...modulesByOwner.entries()]
    .flatMap(([owner, held]) => held.map((moduleId) => `${owner}/${moduleId}`))
    .sort(byCodeUnit);
}

/**
 * The committed census, or a throw naming the command that writes one.
 *
 * REFUSES A MISSING OR MALFORMED PIN rather than treating it as an empty census, for the
 * reason the census itself refuses a missing build: an empty reading is indistinguishable
 * from a clean one, and a comparison against `[]` would report the whole initial graph as
 * newly arrived — a diff so large nobody reads it, which is the same silence as no check.
 *
 * IT ALSO REFUSES A PIN OUT OF ORDER OR HOLDING A DUPLICATE. The comparison is against a
 * sorted, deduplicated census, so either would fail as a difference — reported as a
 * reordering of a thousand entries rather than as the one hand edit that caused it.
 *
 * @param pinPath - An escape for reading a planted pin, which is what the refusal cases
 *   drive; NOT an escape from reading the committed one. Defaults to it.
 */
export function readInitialGraphPin(pinPath: string = INITIAL_GRAPH_PIN_PATH): InitialGraphPin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pinPath, "utf8"));
  } catch (readError) {
    throw new InitialGraphPinUnreadableError(
      `${pinPath} could not be read as the committed initial-graph census. It is ` +
        `regenerated with:\n  ${INITIAL_GRAPH_PIN_REGENERATION_COMMAND}`,
      { cause: readError },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new InitialGraphPinUnreadableError(
      `${pinPath} is not an array of owner-qualified modules, so there is no committed ` +
        "census to compare the build against",
    );
  }
  const entries: unknown[] = parsed;
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "string") {
      throw new InitialGraphPinUnreadableError(
        `${pinPath} holds a non-string entry at index ${index} (\`${typeof entry}\`), ` +
          "so the modules it pins cannot be read",
      );
    }
  }
  const pinned = entries as readonly string[];
  const ordered = [...pinned].sort(byCodeUnit);
  if (pinned.some((entry, index) => entry !== ordered[index])) {
    throw new InitialGraphPinUnreadableError(
      `${pinPath} is not in code-unit order, so a comparison against it would report ` +
        "the reordering rather than whatever else changed",
    );
  }
  if (new Set(pinned).size !== pinned.length) {
    throw new InitialGraphPinUnreadableError(
      `${pinPath} names a module twice, which no census this is compared against can ` +
        "produce, so the pin describes a graph the build cannot hold",
    );
  }
  return pinned;
}

/** Write the census read from the build over the committed pin, newline-terminated. */
export function writeInitialGraphPin(census: InitialGraphPin): void {
  writeFileSync(INITIAL_GRAPH_PIN_PATH, `${JSON.stringify(census, null, 2)}\n`, "utf8");
}

/**
 * What joined the initial graph and what left it, and what to do about it.
 *
 * The report is uncapped on purpose. A delta long enough to be worth truncating is a
 * change big enough that truncating it is how the one line that mattered gets dropped.
 */
export function formatInitialGraphPinDelta(pinned: InitialGraphPin, read: InitialGraphPin): string {
  const before = new Set(pinned);
  const after = new Set(read);
  const joined = read.filter((module) => !before.has(module));
  const left = pinned.filter((module) => !after.has(module));
  if (joined.length === 0 && left.length === 0) {
    return "The census and the pin hold the same modules under the same owners.";
  }
  return [
    "The renderer's initial import graph is not the one this repository pinned.",
    "",
    ...joined.map((module) => `  + ${module}`),
    ...left.map((module) => `  - ${module}`),
    "",
    "A `+` line is the finding, whether or not its owner is new: ask the registration",
    "question `apps/desktop/AGENTS.md` §Import boundaries states — is this painted before",
    'a person acts? — and answer it with `body: () => import("./<name>-body.js")`, with a',
    "deleted door line, or by moving the pin deliberately. A `-` line is a diet that",
    "worked, and the pin moves with it. Either way the pin moves by running:",
    `  ${INITIAL_GRAPH_PIN_REGENERATION_COMMAND}`,
  ].join("\n");
}
