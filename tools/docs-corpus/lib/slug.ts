// GFM heading-slug computation modeled on github-slugger
// (https://github.com/Flet/github-slugger). Used by the doc-corpus regression
// hooks to verify GitHub-rendered anchor IDs against inbound `file.md#anchor`
// citations elsewhere in the corpus.
//
// We re-implement (rather than depend on github-slugger) so the hook scripts
// stay zero-dep — `node --experimental-strip-types` runs this file directly
// without needing pnpm to resolve a runtime dependency. The strip-regex below
// is reproduced verbatim from github-slugger/regex.js (snapshot 2026-05-01) so
// fidelity tracks GitHub's renderer.
//
// Lychee's slug computation (`lychee-lib/src/extract/markdown.rs`) is the
// CI-time fast path; this TS implementation is the local-test calibration
// surface and the input to `move-heading` skill computations. Divergences
// between the two are documented in `docs/operations/failure-mode-catalog.md`
// (Known Limitations).

import { readFileSync } from "node:fs";

// Reproduced from github-slugger/regex.js. Strips Unicode punctuation /
// symbols. Keeps alphanumerics, hyphens, underscores, and spaces (which the
// downstream replace turns into hyphens). Verbatim reproduction is intentional
// — preserves bit-for-bit fidelity with upstream snapshots so divergence is
// visible at diff time. ESLint's `no-useless-escape` rule fights with the
// upstream's defensive escaping inside the character class; suppress here
// rather than alter the source.
//
/* eslint-disable no-control-regex, no-useless-escape */
const GITHUB_SLUGGER_STRIP =
  /[\0-\x1F!-,\.\/:-@\[-\^`\{-\xA9\xAB-\xB4\xB6-\xB9\xBB-\xBF\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0378\u0379\u037E\u0380-\u0385\u0387\u038B\u038D\u03A2\u03F6\u0482\u0530\u0557\u0558\u055A-\u055F\u0589-\u0590\u05BE\u05C0\u05C3\u05C6\u05C8-\u05CF\u05EB-\u05EE\u05F3-\u060F\u061B-\u061F\u066A-\u066D\u06D4\u06DD\u06DE\u06E9\u06FD\u06FE\u0700-\u070F\u074B\u074C\u07B2-\u07BF\u07F6-\u07F9\u07FB\u07FC\u07FE\u07FF\u082E-\u083F\u085C-\u085F\u086B-\u089F\u08B5\u08C8-\u08D2\u08E2\u0964\u0965\u0970\u2010-\u2027\u2030-\u205E]/gu;
/* eslint-enable no-control-regex, no-useless-escape */

export function slug(text: string): string {
  return text.toLowerCase().replace(GITHUB_SLUGGER_STRIP, "").replace(/ /g, "-");
}

export class SluggerSession {
  private occurrences = new Map<string, number>();

  next(headingText: string): string {
    const base = slug(headingText);
    const seen = this.occurrences.get(base) ?? 0;
    const id = seen === 0 ? base : `${base}-${seen}`;
    this.occurrences.set(base, seen + 1);
    return id;
  }

  reset(): void {
    this.occurrences.clear();
  }
}

export function extractHeadingSlugs(filePath: string): Set<string> {
  const content = readFileSync(filePath, "utf8");
  const slugger = new SluggerSession();
  const slugs = new Set<string>();
  let inFence = false;
  let fenceMarker = "";
  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trimStart();
    if (!inFence && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
      inFence = true;
      fenceMarker = trimmed.startsWith("```") ? "```" : "~~~";
      continue;
    }
    if (inFence) {
      if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(rawLine);
    if (!m) continue;
    const headingText = m[2].trim();
    slugs.add(slugger.next(headingText));
  }
  return slugs;
}
