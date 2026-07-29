#!/usr/bin/env node
// preflight.mjs — plan-execution skill mechanical gate runner.
// Authoritative contract: ../references/preflight-contract.md.
//
// Exit codes:
//   0 — all gates pass; stdout = selected phase number on a single line.
//   1 — gate failed; stdout = self-contained halt message (orchestrator
//       surfaces verbatim).
//   2 — internal error (malformed input); stderr describes; stdout empty.

import { readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { parseManifestBlock, validateEntry, MANIFEST_SCHEMA_VERSION } from "./lib/manifest.mjs";

// ---------- paths ----------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, "..");
const SKILL_MD = resolve(SKILL_ROOT, "SKILL.md");
const REPO_ROOT = resolve(SKILL_ROOT, "..", "..", "..");

// ---------- pure helpers (exported for tests) ----------

export function parseFrontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const lines = match[1].split("\n");
  const result = {};
  let inList = null;
  for (const line of lines) {
    const listKeyMatch = line.match(/^([a-zA-Z_][\w]*)\s*:\s*$/);
    if (listKeyMatch) {
      inList = listKeyMatch[1];
      result[inList] = [];
      continue;
    }
    if (inList) {
      const item = line.match(/^\s+-\s+(.+?)\s*$/);
      if (item) {
        result[inList].push(item[1].trim());
      } else if (/^\S/.test(line)) {
        inList = null;
      }
    }
  }
  return result;
}

// Accept "—" (em-dash, plan-template canonical), ":" (Plan-007/008/023 style),
// or "-" (hyphen-minus) as the Phase-heading separator. Plan-007's mid-execution
// status makes a corpus-wide rename out of scope; tolerating both forms in the
// parser keeps the tool usable across the existing corpus without authorising
// drift in new plans (plan-template still documents em-dash as the convention).
export function walkPhases(planSource) {
  const re = /^### Phase (\d+)\s*(?:—|:|-)\s*(.+?)\s*$/gm;
  const phases = [];
  let m;
  while ((m = re.exec(planSource)) !== null) {
    phases.push({ number: Number(m[1]), title: m[2].trim() });
  }
  return phases;
}

export function extractPhaseSection(planSource, phaseNumber) {
  const startRe = new RegExp(`^### Phase ${phaseNumber}\\s*(?:—|:|-)\\s*.+$`, "m");
  const startMatch = startRe.exec(planSource);
  if (!startMatch) return null;
  const startIdx = startMatch.index;
  const bodyStart = startIdx + startMatch[0].length;
  // Bound the section at the next phase heading (`### Phase N`) OR the next
  // level-2 `## ` sibling section (Rollout Order / Risks / Progress Log / Done
  // Checklist), whichever comes first. The `## ` boundary is load-bearing:
  // without it the LAST phase ran to EOF and swallowed the Progress Log's
  // Shipment Manifest ```yaml block (and Done Checklist) into its section —
  // which (a) let parsePreconditionsBlock mistake the manifest for an empty
  // preconditions block and silently skip the prose **Precondition:** gate
  // (last-phase gate no-op), and (b) risked Gate-3 task-id / Gate-4 cite tokens
  // bleeding in from trailing prose. `## ` (two hashes + space) matches neither
  // `### Phase` nor `#### Tasks` (three / four hashes).
  //
  // The boundary scan is fence-aware (findSectionBoundary): a `### Phase N` or
  // `## ` line INSIDE a fenced code block — a shell `## comment`, a markdown
  // example heading — is phase body, not a section boundary, so a phase that
  // carries such an example is no longer severed from its `#### Tasks` block.
  const endRel = findSectionBoundary(planSource.slice(bodyStart));
  const endIdx = endRel === -1 ? planSource.length : bodyStart + endRel;
  return planSource.slice(startIdx, endIdx);
}

// Shared per-line structural-scan state for findSectionBoundary and
// findSectionHeading — one transition function so the two scanners cannot
// drift (Codex round-4, PR #224). Tracks the CommonMark non-content
// regions that can hide or fabricate headings:
//
// Fenced code blocks, per CommonMark: an opening ``` / ~~~ run of length N
// at AT MOST 3 spaces of indentation (4+ spaces is an indented code block
// whose literal ``` must not open fence state) opens a block that only a
// closing run of the same character and length >= N — bare remainder, no
// info string — closes, so a longer outer run contains shorter inner runs
// (a 4-backtick fence wraps 3-backtick lines), matching the nesting plans
// use. A BACKTICK fence's info string may not itself contain a backtick
// (CommonMark 4.5; parity with tools/docs-corpus advanceScanState —
// Codex round-6, PR #224): a ```ts`x line is inline code, not a
// delimiter, and must not swallow the headings that follow. Tilde info
// strings may carry backticks; closers are unaffected (their tails are
// whitespace-only). The corpus holds 1-3-space list-indented fences
// (Plan-026) and no deeper ones, so the flat 0-3 rule is exact for every
// real doc.
//
// Raw HTML blocks (CommonMark 4.6 types 1-6): `<pre>`/`<script>`/
// `<style>`/`<textarea>` blocks (type 1, closed by the line carrying the
// matching end tag), multi-line HTML comments (type 2), processing
// instructions / declarations / CDATA (types 3-5, closed by `?>` / `>` /
// `]]>`), and block-level tag lines (type 6, closed by the next blank
// line) all render as raw HTML, so a `## Phantom` inside any of them is
// not a citable heading and must not terminate a phase section (Codex
// round-6, PR #224). Type 7 (a lone arbitrary complete tag) is
// deliberately not modeled: it cannot interrupt a paragraph, so honoring
// it without paragraph tracking would over-consume prose, and the corpus
// holds no such blocks. Type-2 comments keep mid-line open semantics (an
// inline `<!-- ... -->` spanning lines is equally non-rendered); the
// `--` interior restrictions of the HTML spec are not modeled — this is
// a structural approximation for lint scanning.
//
// Multi-line inline code spans: a span whose equal-length backtick runs
// sit on different lines is code in between, so a raw `<!--` there is
// prose, not a comment opener (Codex round-6, PR #224). A run OPENS a
// span only when an equal-length run closes it before the paragraph can
// end — the lookahead stops at blank lines, headings, fence delimiters,
// thematic breaks, list starts, and HTML-block opens, the constructs
// CommonMark lets interrupt a paragraph — otherwise the run is literal
// backticks and any `<!--` after it counts. Block precedence holds by
// construction: a confirmed span's interior can contain none of those
// interrupters, so no real heading is ever consumed as span content.
function createStructuralScanState() {
  return { fenceChar: "", fenceLen: 0, htmlBlockClose: null, spanLen: 0 };
}

// CommonMark 4.6 type-6 tag names (block-level HTML). `pre`/`script`/
// `style`/`textarea` are type 1 and matched first.
const HTML_BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul",
]);

// HTML-block open detection (line-start, <=3-space indent, per CommonMark
// 4.6). Returns the close-condition kind or null. Comments (type 2) are
// NOT opened here — their mid-line open semantics live in
// scanLineContent, and `<!--` matches none of these patterns.
function htmlBlockOpenKind(content) {
  if (/^ {0,3}<(?:pre|script|style|textarea)(?=[\s/>]|$)/i.test(content)) return "tag";
  if (/^ {0,3}<\?/.test(content)) return "pi";
  if (/^ {0,3}<!\[CDATA\[/.test(content)) return "cdata";
  if (/^ {0,3}<![A-Za-z]/.test(content)) return "decl";
  const tagMatch = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(content);
  if (tagMatch && HTML_BLOCK_TAGS.has(tagMatch[1].toLowerCase())) return "blank";
  return null;
}

// Applies an open HTML block's end condition to `line`, clearing the state
// when it closes. Called from the in-block branch AND on the open line
// itself — types 1 and 3-5 may open and close on ONE line (`<!DOCTYPE
// html>`), and skipping the same-line check would swallow the document
// tail. Close detection reads the raw line: block interiors are raw HTML
// where backticks have no code-span meaning.
function advanceHtmlBlockClose(state, line) {
  if (state.htmlBlockClose === "comment") {
    if (line.includes("-->")) {
      state.htmlBlockClose = line.lastIndexOf("<!--") > line.lastIndexOf("-->") ? "comment" : null;
    }
    return;
  }
  if (state.htmlBlockClose === "blank") {
    if (/^\s*$/.test(line)) state.htmlBlockClose = null;
    return;
  }
  if (
    (state.htmlBlockClose === "tag" && /<\/(?:pre|script|style|textarea)>/i.test(line)) ||
    (state.htmlBlockClose === "pi" && line.includes("?>")) ||
    (state.htmlBlockClose === "decl" && line.includes(">")) ||
    (state.htmlBlockClose === "cdata" && line.includes("]]>"))
  ) {
    state.htmlBlockClose = null;
  }
}

// First backtick run of EXACTLY `length` in `text` (a longer run is not a
// span closer, per CommonMark), or null.
function findEqualBacktickRun(text, length) {
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("`", i);
    if (start === -1) return null;
    let end = start;
    while (end < text.length && text[end] === "`") end += 1;
    if (end - start === length) return { start, end };
    i = end;
  }
  return null;
}

// A line that ends the paragraph a tentative code span lives in — the
// span opener is literal backticks when one of these arrives before its
// closer. Tested on blockquote-stripped content; quote depth is
// deliberately transparent here. That is this helper's OWN simplification
// and no longer mirrors the shared tracker, which models an ordered
// container stack (task #83 round 2): a code span is a single-paragraph
// question, so the containers a paragraph sits in cannot change inside it.
function isParagraphInterrupter(content) {
  if (/^\s*$/.test(content)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(content)) return true;
  if (/^ {0,3}([-_*])(?:[ \t]*\1){2,}[ \t]*$/.test(content)) return true;
  if (/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]/.test(content)) return true;
  const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
  if (fenceMatch && !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))) return true;
  return htmlBlockOpenKind(content) !== null;
}

// Does a backtick run of exactly `length` arrive before a paragraph
// interrupter? Decides tentative span openers at open time, so an
// unclosed run never retroactively masks a real `<!--`.
function multilineSpanCloses(lines, from, length) {
  for (let i = from; i < lines.length; i += 1) {
    const content = lines[i].replace(/^(?: {0,3}>)+ ?/, "");
    if (isParagraphInterrupter(content)) return false;
    if (findEqualBacktickRun(content, length) !== null) return true;
  }
  return false;
}

// Scans one line's content (or the tail after a multi-line span closer)
// for code spans and comment openers, mutating `state`. Backtick runs
// walk left to right: a run pairing with a same-line equal-length run is
// a same-line span (interior masked); a run whose closer sits on a later
// line — confirmed via multilineSpanCloses — opens span state and ends
// the walk; an unclosed run is literal and the walk continues after it.
// A raw `<!--` in the surviving prose opens comment state; inside
// backticks it is prose (`use \`<!--\` to open a comment` must not
// swallow later headings — Codex rounds 5-6, PR #224).
function scanLineContent(state, lines, index, text) {
  let prose = "";
  let i = 0;
  while (i < text.length) {
    const runStart = text.indexOf("`", i);
    if (runStart === -1) {
      prose += text.slice(i);
      break;
    }
    prose += text.slice(i, runStart);
    let runEnd = runStart;
    while (runEnd < text.length && text[runEnd] === "`") runEnd += 1;
    const runLength = runEnd - runStart;
    const sameLineCloser = findEqualBacktickRun(text.slice(runEnd), runLength);
    if (sameLineCloser) {
      i = runEnd + sameLineCloser.end;
      continue;
    }
    if (multilineSpanCloses(lines, index + 1, runLength)) {
      state.spanLen = runLength;
      break;
    }
    i = runEnd;
  }
  if (prose.lastIndexOf("<!--") > prose.lastIndexOf("-->")) {
    // The line OPENS an unclosed comment; text before the `<!--` is still
    // content (a real heading carrying a trailing comment opener keeps its
    // boundary role — its § match self-excludes on the polluted tail).
    state.htmlBlockClose = "comment";
  }
}

// Blockquote-prefix strip, held byte-equal to `stripBlockquotePrefix` in
// tools/docs-corpus/lib/markdown-fences.ts: a quoted fence opener (`> ```md`)
// with lazy-continuation interior lines hides quoted example headings exactly
// like an unquoted fence (Codex round-5, PR #224). Quoted and unquoted fences
// share one state stream — the same flat approximation the shared tracker
// makes.
//
// Exported ONLY so that equality can be asserted rather than asserted-in-prose.
// This file cannot import the shared module at the engines floor: `preflight.mjs`
// runs under bare `node` (SKILL.md Phase 0.2), and on Node 22.12 — the
// `package.json` engines minimum — loading a `.ts` source fails outright with
// ERR_UNKNOWN_FILE_EXTENSION. (Node 22.18+ strips types by default, so this is
// a statement about the floor the skill must support, not about every Node.)
// Duplication is therefore forced here — so the duplicate is pinned by
// `preflight-external-contracts.test.mjs` instead of by a comment claiming
// parity, which is what this comment used to be.
export const BLOCKQUOTE_PREFIX_RE = /^(?: {0,3}>)+ ?/;

// Advances `state` across `lines[index]`. Returns true when the line is
// structural interior/delimiter (fence delimiter, fenced content, raw
// HTML block, multi-line span interior) that no heading scan may read;
// false when the line is document content. Takes the whole line array:
// tentative span openers need lookahead to the closer-or-interrupter.
function structuralScanConsumes(state, lines, index) {
  const line = lines[index];
  // Fence detection reads the stripped content; heading tests in the callers
  // stay raw, so `> ## quoted` is still not a heading.
  const content = line.replace(BLOCKQUOTE_PREFIX_RE, "");
  const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
  const fence =
    fenceMatch && !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`")) ? fenceMatch : null;
  if (state.fenceChar !== "") {
    if (
      fence &&
      fence[1][0] === state.fenceChar &&
      fence[1].length >= state.fenceLen &&
      /^\s*$/.test(fence[2])
    ) {
      state.fenceChar = "";
      state.fenceLen = 0;
    }
    return true;
  }
  if (state.htmlBlockClose !== null) {
    advanceHtmlBlockClose(state, line);
    return true;
  }
  if (state.spanLen > 0) {
    const closer = findEqualBacktickRun(content, state.spanLen);
    if (closer === null) return true;
    state.spanLen = 0;
    // The rest of the line after the closer is ordinary content and may
    // itself open a new span or comment; the line as a whole is still
    // consumed (it starts with span interior, so it cannot be a heading).
    scanLineContent(state, lines, index, content.slice(closer.end));
    return true;
  }
  if (fence) {
    state.fenceChar = fence[1][0];
    state.fenceLen = fence[1].length;
    return true;
  }
  const htmlKind = htmlBlockOpenKind(content);
  if (htmlKind !== null) {
    state.htmlBlockClose = htmlKind;
    advanceHtmlBlockClose(state, line);
    return true;
  }
  scanLineContent(state, lines, index, content);
  return false;
}

// Blank every line the structural scanner consumes — fenced code, raw-HTML
// blocks, HTML comments, multi-line inline code spans — preserving each line's
// exact byte length.
//
// Length-preserving is load-bearing, not tidiness. Cite extraction is
// offset-driven: `marker.index` slices the payload, and `lineNo` is derived by
// counting newlines in the prefix. Replacing a consumed line with spaces (not
// with "") keeps every downstream offset and every reported line number
// byte-identical to the raw source, so masking changes which markers are SEEN
// without moving any of them.
//
// A `**Spec coverage:**` row inside a fenced ```markdown example is
// illustration, not audit output. Counting it let a phase-less plan whose ONLY
// markers lived in an example block report as cite-swept, non-vacuous and
// anomaly-free — a complete false clean, the same class this screen exists to
// close (Codex P2, PR #260 round 2). The scanner's other regions carry the same
// argument: a marker inside an HTML comment or an indented code span does not
// render either.
//
// Measured against the live corpus when armed: zero plans carry a bold cite
// marker inside any consumed region, so this moves no existing verdict — it
// closes the shape before a plan lands that has one.
function maskNonContentLines(text) {
  const lines = text.split("\n");
  // Masked into a COPY: structuralScanConsumes reads ahead in `lines` (the
  // multi-line code-span lookahead), so the scan must keep seeing raw text.
  const masked = lines.slice();
  const scanState = createStructuralScanState();
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (structuralScanConsumes(scanState, lines, lineIndex)) {
      masked[lineIndex] = " ".repeat(lines[lineIndex].length);
    }
  }
  return masked.join("\n");
}

// Blank the INTERIOR of every same-line inline code span, preserving byte
// length for the same offset-stability reason as maskNonContentLines.
//
// maskNonContentLines is LINE-granular by construction — structuralScanConsumes
// reports "this whole line is a structural region", which is the right shape
// for fences, raw-HTML blocks and MULTI-line spans. A span that opens and
// closes on one line is sub-line: blanking the line would take real prose with
// it, so it is masked here instead, at span granularity.
//
// The delimiters themselves are left in place; only the bytes between an
// opening run and its closer are blanked. A run with no closer is prose — a
// lone backtick does not open a span that swallows the rest of the line.
//
// Closers are found by SEARCHING FORWARD for the next run of equal length, per
// CommonMark, not by pairing runs off two at a time. Positional pairing is
// wrong whenever a line holds an unmatched run before a real span: in
// "Use `` for empty, and `**Spec coverage:**` here." the runs are [2, 1, 1],
// positional pairing compares (2,1), skips BOTH on the length mismatch, and
// leaves the genuine span at (1,2) unmasked — so the marker inside it counts as
// audit output. That fails OPEN, the same direction as the hole this masker
// exists to close.
//
// KNOWN, MEASURED LIMIT: spans are masked per LINE by design, but CommonMark
// inline code spans can cross line boundaries inside a paragraph, so a marker
// on a multiline span's opening line stays visible to the counters and the
// extractor (Codex P2, PR #262 round 8). Declined with measurement: the
// corpus holds ZERO multiline inline spans (58 plan+spec files, paragraph-
// scoped residual-parity scan) — and the miss is LOUD, not silent: an
// illustrated marker on such a line draws a spurious verification failure
// under --enforce-cites rather than passing anything unverified. Sub-line
// span state across lines is inline tokenization — owned by the
// gate-hardening sweep's fence-tracker unification, alongside CommonMark
// indented code (see the matching note at taskHeaderMatches).
export function maskInlineCodeSpans(text) {
  const lines = text.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.includes("`")) continue;
    // Two CommonMark escaping rules bound what counts as a delimiter (Codex
    // P2, PR #262 round 7):
    //   1. A backslash-escaped backtick is literal, so it cannot OPEN a span.
    //      `\`**Spec coverage:** ...\`` is prose around a real marker — pairing
    //      those escaped runs blanked the marker out of every counter and let
    //      --survey --enforce-cites pass without verifying its anchor.
    //   2. Backslash escapes do not work INSIDE code spans, so a closer is
    //      never escape-checked: in `` `a\` `` the second backtick closes.
    // An odd number of preceding backslashes escapes the run's first backtick
    // only; the remainder still forms a (shorter) run for opener purposes.
    const runs = [...line.matchAll(/`+/g)].map((match) => {
      let backslashes = 0;
      for (let at = match.index - 1; at >= 0 && line[at] === "\\"; at -= 1) backslashes += 1;
      const escapedFirst = backslashes % 2 === 1;
      return {
        index: match.index,
        length: match[0].length,
        openIndex: match.index + (escapedFirst ? 1 : 0),
        openLength: match[0].length - (escapedFirst ? 1 : 0),
      };
    });
    let masked = line;
    let runIndex = 0;
    while (runIndex < runs.length) {
      const open = runs[runIndex];
      if (open.openLength === 0) {
        // Fully escaped: literal backtick, never an opener. It remains a
        // valid CLOSER candidate for earlier openers via its raw length.
        runIndex += 1;
        continue;
      }
      let closeIndex = -1;
      for (let candidate = runIndex + 1; candidate < runs.length; candidate += 1) {
        // Raw length on the closer side — rule 2 above.
        if (runs[candidate].length === open.openLength) {
          closeIndex = candidate;
          break;
        }
      }
      if (closeIndex === -1) {
        // No closer of matching length: this run is literal. Advance by ONE so
        // the runs after it are still considered as openers.
        runIndex += 1;
        continue;
      }
      const from = open.openIndex + open.openLength;
      const to = runs[closeIndex].index;
      masked = masked.slice(0, from) + " ".repeat(to - from) + masked.slice(to);
      runIndex = closeIndex + 1;
    }
    lines[lineIndex] = masked;
  }
  return lines.join("\n");
}

// The CITE content boundary: what counts as audit output for cite screening.
// One definition, three consumers (countCites, classifyPhaseMarkers,
// extractCiteAnchors) — settled in one place for the same reason round 4
// masked the INPUT to extractTasksBlock rather than its three call sites: a
// consumer holding a different view of which bytes are content is how a gate
// reports clean over work it did not do.
//
// A marker inside an inline code span is illustration. Prose reading "write
// `**Spec coverage:** Spec-001 §Goals`" was previously EXTRACTED and VERIFIED:
// the example resolved against real spec files and reported clean, and a unit
// whose only markers were illustrations passed the floor as audited (Codex P2,
// PR #262 round 5). The fenced-block form of exactly this argument is at
// maskNonContentLines; a same-line span renders as code for the same reason.
//
// Measured across every phase and complement unit in the live corpus (walking
// `### Phase` headings directly — both walkPhases and the integer
// extractPhaseSection walk are blind to R-remainder and supplement labels, so
// neither is a safe denominator here): ZERO units flip the floor they are
// actually evaluated under. Eight units' raw counts move and four complements'
// STRICT floor would flip, but complements are screened on the relaxed arm by
// construction (`requireBothMarkers: false`), and no PHASE unit moves either
// floor. Re-run that measurement before narrowing or widening this boundary.
export function maskCiteContent(text) {
  return maskInlineCodeSpans(maskNonContentLines(text));
}

// Byte offset within `body` of the first `### Phase N` / `## ` heading that
// sits OUTSIDE any fenced code block or multi-line HTML comment, or -1 if
// none. Split out of extractPhaseSection so the structural state machine is
// unit-testable on its own.
export function findSectionBoundary(body) {
  let offset = 0;
  const scanState = createStructuralScanState();
  const lines = body.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    // Remainder headings (`### Phase R2`) are real section boundaries too:
    // digit-only matching made the preceding numbered phase swallow the
    // R-section, so its declared-task set absorbed the R-series ids and a
    // shipped numbered phase classified partially_shipped forever (latent
    // Plan-007 Phase 3 false-halt; surfaced by the external_plan_phase_merged
    // work, Codex P2 PR #193 round 4). The deliberately unanchored prefix
    // also makes supplement headings (`### Phase 3B`) boundaries — do not
    // anchor this to `R?\d+$`-style exactness or the numbered phase before a
    // supplement swallows it (same failure class).
    if (
      !structuralScanConsumes(scanState, lines, lineIndex) &&
      (/^### Phase R?\d+/.test(line) || /^## /.test(line))
    ) {
      return offset;
    }
    offset += line.length + 1; // +1 restores the "\n" consumed by split
  }
  return -1;
}

// Fence-masked: this count is what `hasCiteMarkers` keys on, so a fenced
// example's markers reaching it is what makes an unaudited phase read as
// audited (Codex P2, PR #260 round 2).
export function countCites(phaseSection) {
  const scanned = maskCiteContent(phaseSection);
  return {
    spec_coverage: (scanned.match(/Spec coverage/g) || []).length,
    verifies_invariant: (scanned.match(/Verifies invariant/g) || []).length,
  };
}

// Survey-layer marker-shape classifier. The dispatch gate keys hasCiteMarkers
// on countCites (a bare substring count) and MUST stay byte-identical, so this
// finer classification lives only in --survey. It separates BOLD field markers
// (`**Spec coverage:**` / `**Verifies invariant:**` — the only shape
// extractCiteAnchors parses) from UNBOLD/inline field markers (the Plan-008
// `- **T-…** (…; Verifies invariant: …; Spec coverage: …)` style the bold
// extractor silently skips). Both alternatives are line-anchored to a field
// position — a bullet head (`- Spec coverage:`) or an inline `;`/`(` delimiter
// — so a prose sentence mentioning "Spec coverage" without a field colon is
// never counted. Used by the survey to surface the partial-marker (one side
// present) and legacy-unbold (marker the bold extractor can't verify) classes.
export function classifyPhaseMarkers(phaseSection) {
  const counts = { boldSpec: 0, boldInvariant: 0, unboldSpec: 0, unboldInvariant: 0 };
  // Masked for the same reason as countCites: an example is not audit output,
  // and this classifier feeds the partial/unbold marker screens.
  const scanned = maskCiteContent(phaseSection);
  const boldMarker = /\*\*(Spec coverage|Verifies invariant):\*\*/g;
  for (const match of scanned.matchAll(boldMarker)) {
    if (match[1] === "Spec coverage") counts.boldSpec += 1;
    else counts.boldInvariant += 1;
  }
  // Field position, not wrapped in `**`: a bullet head (`^  - Spec coverage:`)
  // or an inline `;`/`(` delimiter (`; Verifies invariant:`). The trailing
  // `(?!\*)` keeps the bold form above from being double-counted here.
  const unboldMarker = /(?:^\s*[-*]+\s+|[;(]\s*)(Spec coverage|Verifies invariant):(?!\*)/gm;
  for (const match of scanned.matchAll(unboldMarker)) {
    if (match[1] === "Spec coverage") counts.unboldSpec += 1;
    else counts.unboldInvariant += 1;
  }
  return counts;
}

export function extractAuditCheckbox(planSource) {
  return /^- \[x\] \*\*Plan-readiness audit complete/m.test(planSource);
}

export function parseFlowMapping(line) {
  const inner = line.match(/\{(.+?)\}/)?.[1];
  if (!inner) return null;
  const obj = {};
  for (const pair of inner.split(",")) {
    const colonIdx = pair.indexOf(":");
    if (colonIdx === -1) continue;
    const k = pair.slice(0, colonIdx).trim();
    let v = pair.slice(colonIdx + 1).trim();
    if (!k) continue;
    if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    else if (/^"[^"]*"$|^'[^']*'$/.test(v)) v = v.slice(1, -1);
    obj[k] = v;
  }
  return obj;
}

export function parsePreconditionsBlock(phaseSection) {
  // Accept both ```yaml and ```yml — markdown writers use either; treating
  // them differently produces silent gate-skips when a plan author picks the
  // shorter fence.
  //
  // A yaml block is only a *preconditions* block if it contains a top-level
  // `preconditions:` key. Select that block specifically — other yaml blocks in
  // a phase section (a schema/data example in a task body, or the Progress Log
  // Shipment Manifest if it lands in the section) are NOT preconditions blocks.
  // Returning [] for them conflated "no preconditions block" with "empty
  // preconditions list", which made gatePreconditions skip the prose
  // **Precondition:** fallback and vacuously pass — the silent gate-disable seen
  // on the last phase of every manifested plan (Plan-001 P5, Plan-002 P6,
  // Plan-003 P5) and on Plan-002 Phase 2's in-body example. Return null (no
  // preconditions block) so the prose fallback runs.
  let blockBody = null;
  for (const m of phaseSection.matchAll(/```ya?ml\s*\n([\s\S]*?)\n```/g)) {
    if (/^\s*preconditions\s*:/m.test(m[1])) {
      blockBody = m[1];
      break;
    }
  }
  if (blockBody === null) return null;
  const lines = blockBody.split("\n");
  // Track the column at which `preconditions:` was found (-1 means we're not
  // inside the block). The first list item after the key locks `itemIndent`;
  // subsequent items must match that exact indent. Both YAML block-sequence
  // forms are accepted: compact (`indent === preIndent`, e.g.
  // `preconditions:\n- {…}`) and expanded (`indent > preIndent`, e.g.
  // `preconditions:\n  - {…}`). Locking on the first item prevents a sibling
  // list at the parent key's indent from being falsely absorbed in expanded
  // mode. De-indenting back to the key's column or shallower with a non-list,
  // non-comment-only line exits the block; comments are metadata and never
  // change parser state. Re-arming on a subsequent `preconditions:` key keeps
  // the parser forgiving against malformed YAML.
  let preIndent = -1;
  let itemIndent = -1;
  const entries = [];
  for (const line of lines) {
    // Accept trailing whitespace and an optional YAML line-comment after the
    // colon (e.g. `preconditions: # gated by ADR-023`). Reject inline values
    // (`preconditions: foo` or `preconditions: []`) so an inline-empty list
    // doesn't falsely enter block mode and silently swallow following lines.
    const keyMatch = line.match(/^(\s*)preconditions\s*:\s*(#.*)?$/);
    if (keyMatch) {
      preIndent = keyMatch[1].length;
      itemIndent = -1;
      continue;
    }
    if (preIndent < 0) continue;
    const itemMatch = line.match(/^(\s*)-\s+/);
    if (itemMatch) {
      const indent = itemMatch[1].length;
      if (itemIndent < 0 && indent >= preIndent) itemIndent = indent;
      if (indent === itemIndent) {
        const entry = parseFlowMapping(line);
        if (entry) entries.push(entry);
        continue;
      }
      // List item at unexpected indent (e.g., a sibling list outside the
      // preconditions block in expanded mode) — fall through to exit logic.
    }
    // Comments are metadata — never trigger block exit, regardless of their
    // indent. In compact form (`indent === preIndent`) a comment-only line at
    // the parent indent would otherwise satisfy the de-indent exit check and
    // silently drop subsequent items, producing a gate-skip on later
    // preconditions. Match `# foo` or `   # foo` but not `key: # trailing`,
    // which is a key-with-trailing-comment.
    if (/\S/.test(line) && !/^\s*#/.test(line)) {
      const lineIndent = line.match(/^\s*/)[0].length;
      if (lineIndent <= preIndent) {
        preIndent = -1;
        itemIndent = -1;
      }
    }
  }
  return entries;
}

export function regexParsePreconditionsLine(line, localPlanNumber) {
  const entries = [];
  for (const m of line.matchAll(/PR\s*#(\d+)\s+merged/gi)) {
    entries.push({ type: "pr_merged", ref: Number(m[1]) });
  }
  for (const m of line.matchAll(/ADR-(\d{3})\s+accepted/gi)) {
    entries.push({ type: "adr_accepted", ref: Number(m[1]) });
  }
  for (const m of line.matchAll(/Plan-(\d{3})\s+Phase\s*(\d+)\s+(?:approved|merged)/gi)) {
    entries.push({ type: "plan_phase", plan: Number(m[1]), phase: Number(m[2]), status: "merged" });
  }
  // Cross-tier deferral on an un-decomposed upstream plan. The corpus convention
  // for a precondition gated on a plan that has NOT yet been decomposed into
  // phases (no `### Phase` sections, no shipment manifest) is the prose form
  // `Plan-NNN Tier M (merged|complete|ships) …` — distinct from the
  // `Plan-NNN Phase N merged` form above (resolved against the upstream's
  // per-phase manifest by the plan_phase case). Corpus examples: Plan-002
  // Phase 4 (`[Plan-021](…) Tier 6 ships the rateLimitProcedure …`), Plan-002
  // Phase 2 (`[Plan-025 Tier 1 Partial](…) merged`), Plan-002 Phase 6
  // (`Plan-023 Tier 1 Partial complete`). Without this branch the line falls
  // through to gatePreconditions' "unparseable prose → legacy free-form →
  // silent pass", which lets a phase whose ONLY other precondition token is
  // already satisfied (e.g. a local `Phase 2 merged`) resolve eligible while
  // its cross-tier substrate is still absent — the Plan-002 Phase 4
  // false-eligible the auto-walk hit before this fix. The optional `](url)`
  // groups absorb the markdown link whether the plan number sits in the link
  // TARGET (`[Plan-021](url) Tier 6 ships`) or inside the link TEXT
  // (`[Plan-025 Tier 1 Partial](url) merged`).
  for (const m of line.matchAll(
    /Plan-(\d{3})(?:\]\([^)]*\))?\s+Tier\s+\d+(?:\s+Partial)?(?:\]\([^)]*\))?\s+(?:merged|complete|ships)\b/gi,
  )) {
    entries.push({ type: "plan_unshipped", plan: Number(m[1]) });
  }
  // Bare-form `Phase N merged` resolves to the local plan. The corpus convention
  // for same-plan precondition prose is the bare form (Plan-001/003/007/024
  // all use it); without this branch the Gate 5 regex drops the dependency
  // and `gatePreconditions` falls to "unparseable prose; treat as legacy
  // free-form" → silent pass. Negative lookbehind prevents double-counting
  // the `Phase N merged` inside a `Plan-NNN Phase N merged` already captured
  // by the regex above. Callers that omit `localPlanNumber` get the
  // pre-extension behavior (used by the legacy unit-test surface).
  if (Number.isInteger(localPlanNumber)) {
    for (const m of line.matchAll(/(?<!Plan-\d{3}\s+)\bPhase\s*(\d+)\s+(?:approved|merged)/gi)) {
      entries.push({
        type: "plan_phase",
        plan: localPlanNumber,
        phase: Number(m[1]),
        status: "merged",
      });
    }
  }
  return entries;
}

export function extractPlanNumber(planFile) {
  const base = basename(planFile);
  const match = base.match(/^(\d{1,4})-/);
  return match ? Number(match[1]) : null;
}

// Returns ALL files matching `NNN-*.md`. Callers fail-closed when a numeric
// prefix collides (botched rename / bad merge / duplicate doc). Sorted by
// filename for deterministic test output (Codex P2 on PR #96 line 1364).
export function findPaddedFiles(dir, ref) {
  const padded = String(ref).padStart(3, "0");
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(`${padded}-`) && f.endsWith(".md"))
      .sort()
      .map((f) => resolve(dir, f));
  } catch {
    return [];
  }
}

// Display-side pair of the padding `findPaddedFiles` applies on the lookup
// side: a precondition entry carries `plan: 6`, which interpolated raw renders
// "Plan-6" in a user-facing halt against a corpus that writes `Plan-006`
// everywhere. Lookup was always padding-correct — this only fixes what the
// reader sees, so it must never be threaded into a path or a match.
export function planLabel(planNumber) {
  return `Plan-${String(planNumber).padStart(3, "0")}`;
}

// Same convention for ADR references: `{type: adr_accepted, ref: 14}` rendered
// raw reads "ADR-14" against a corpus that writes `ADR-014` (Plan-008 carries
// exactly that live entry). Display-only, like `planLabel`.
export function adrLabel(adrNumber) {
  return `ADR-${String(adrNumber).padStart(3, "0")}`;
}

// Returns ALL paths under `dir` whose basename matches `filename`, recursing
// through `contracts/` / `schemas/` subdirs the cites omit. Callers fail-closed
// when a filename collides across subdirs (Codex P2 on PR #96 line 1364).
export function findArchDocFiles(dir, filename) {
  const out = [];
  function walk(d) {
    try {
      const entries = readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) walk(resolve(d, e.name));
        else if (e.name === filename) out.push(resolve(d, e.name));
      }
    } catch {
      /* ignore unreadable subdirs */
    }
  }
  walk(dir);
  return out.sort();
}

export function extractAdrStatus(source) {
  // Markdown table cell:  | **Status** | accepted |  (or `accepted`)
  const tableMatch = source.match(/\|\s*\*?\*?Status\*?\*?\s*\|\s*`?([\w-]+)`?\s*\|/i);
  if (tableMatch) return tableMatch[1].toLowerCase();
  // Bold-field forms: `**Status:** accepted` (colon inside markers) or
  // `**Status**: accepted` (colon outside). The `Status:?\*\*` allows either.
  const fieldMatch = source.match(/\*\*Status:?\*\*\s*:?\s*`?([\w-]+)`?/i);
  if (fieldMatch) return fieldMatch[1].toLowerCase();
  return null;
}

// Extract the `#### Tasks` block content (without the heading) from a phase
// section. Returns null when the phase has no Tasks block. Factored out so
// extractDeclaredTaskIds and the audit_status:substrate_exempt resolver can
// both slice the same region without re-implementing the heading boundary
// logic.
export function extractTasksBlock(phaseSection) {
  // Fenced examples are ILLUSTRATION, not declared work. A ```markdown block
  // demonstrating the Tasks-row shape (`- **T9.9 — illustrative row**`) is read
  // by every consumer below as a real declared task, and each one fails in a
  // different direction: Gate 3's set-comparison sees a phantom id that will
  // never ship, so a fully-shipped phase reads unshipped and the auto-walk
  // re-enters completed work; `classifyPhaseSize` counts it, moving an S phase
  // to M and demoting G4 grammar findings; and the substrate_exempt resolver
  // halts on a `Spec coverage: [...]` cite that exists only inside the example.
  // The survey oracle could not catch any of it — it scanned the same raw text
  // and agreed (Codex P2, PR #262 round 4).
  //
  // Masking here rather than at the three call sites is deliberate: this is the
  // one place that decides what text IS the Tasks block, so the content
  // boundary is settled once and no consumer can hold a different view of it.
  // The oracle's independence is a claim about the ROW-SHAPE recognizer, not
  // about which bytes are content — sharing this boundary is what stops the
  // oracle from reporting a phantom row the extractor is right to skip.
  //
  // Masking the INPUT, not the sliced blocks: maskNonContentLines starts its
  // fence tracker closed, and a phase section always begins at a fence-closed
  // point (findSectionBoundary is fence-aware), so parity holds. Masking the
  // joined blocks instead would start the tracker mid-document and invert the
  // parity of every fence inside them.
  //
  // Measured against the live corpus: masking changes ZERO declared-id sets,
  // ZERO block-presence verdicts, and ZERO oracle rows across every phase
  // carrying a Tasks block. Both directions were checked — no real row is
  // masked away either, because a task row indented under a bullet is not a
  // structural region (the scanner consumes fences, raw-HTML blocks, and
  // multi-line code spans; a 2-space list indent is none of those).
  const scanned = maskNonContentLines(phaseSection);
  // A phase's declared tasks are the UNION of all its `#### Tasks` blocks —
  // refinement-lane phases (Plan-007 Phase 3, Plan-008 Phase 1) carry a second
  // block, and reading only the first made its task ids invisible to Gate 3:
  // the phase could read fully_shipped while lane tasks were still pending
  // (same class as the Codex P1 on PR #190; found by the omission survey).
  const blocks = [...scanned.matchAll(/####\s*Tasks\s*\n([\s\S]*?)(?=\n####\s|\n###\s|$)/g)].map(
    (m) => m[1],
  );
  return blocks.length ? blocks.join("\n") : null;
}

// The corpus's task-header spellings, defined ONCE. Two independent copies of
// this recognizer already drifted: Gate 3's declared-id extractor was hardened
// on PR #190 to accept every shape, while the cite-attribution copy kept the
// narrow `**id**` form and silently mis-labeled findings under 241 headers
// across 12 plans (220 of them in-phase). A single definition is the only thing
// that stops "what counts as a task row" from forking again.
//
// (?=[-\d]) pins the task-id SHAPE: a digit (T1.1) or hyphen (T-100-1.1) must
// follow T — otherwise prose bolds/headings starting with T ("Tests:",
// "Testing") phantom-match. A phantom declared id makes Gate 3 see the phase as
// never fully shipped (auto-walk re-enters shipped work — Codex P1, PR #190,
// reproduced on Plan-003 Phase 1).
export const TASK_ID_SHAPE = String.raw`T(?=[-\d])[-a-zA-Z0-9.]+`;

// Both audit-Tasks-block layouts, every observed spelling:
//   A. sub-header     `##### T1.1 — title`
//   B. bullet + bold  `- **T-007p-1-1** (Files: …)`      bold closes after id
//                     `- **T1.1 — title**`               title INSIDE the bold
//                     `- [ ] **T21.1-1 — …**`            GFM checkbox
//                     `  - **T-007r-3-15 (slice a) …**`  indented sub-slice
//
// No closing-`**` tail is required: titles containing a literal `*` (Plan-009
// `repo.*`, Plan-018 `participant.*`, Plan-022 `gdpr.*`) broke a `[^*\n]*\*\*`
// tail, and the omitted id let Gate 3 mark a phase fully shipped with work
// still pending (Codex P1, PR #190).
//
// Indent tolerance is shared deliberately: it was measured corpus-neutral —
// across every phase carrying a `#### Tasks` block it adds ZERO declared ids —
// so both consumers can hold one anchor without moving any Gate-3 verdict.
// Widening this pattern widens a GATING path, not just a diagnostic one;
// `extractDeclaredTaskIds` feeds `classifyPhaseSize`, which demotes G4 grammar
// findings for S/M phases. Re-run that corpus measurement before loosening it.
//
// State no phase COUNT here. Every walk in this file disagrees about how many
// phases exist — `walkPhases` and the integer `extractPhaseSection` walk are
// both blind to R-remainder and supplement labels (`### Phase R3`), so a
// maintainer re-measuring via the production path lands on a different number
// and reads it as drift. The quantifier is what carries the claim; a
// denominator nothing reproduces only decorates it.
//
// The indented alternative admits nested rows whose bold closes immediately
// after the id (`  - **T9.9** is a prerequisite`), which is a REFERENCE, not a
// declaration. That shape is not separable here: 175 live column-0
// declarations across Plan-005/007/008/023/024/025 use exactly it
// (`- **T1.1** — Author the interface`), so rejecting on bold-close position
// would drop real declarations — a missed declaration reads as a phase shipped
// prematurely, which fails OPEN. Closing it needs a POSITIVE discriminator
// (the row carries task metadata: `(Files:`, `**Files:**`), measured on its
// own; zero live instances today (Codex P2, PR #262 round 5, declined with
// measurement).
//
// This recognizer must only ever see CONTENT: `extractTasksBlock` masks fenced
// and raw-HTML regions out of its input, so a fenced example row reaches
// neither consumer. Feeding it raw text re-opens that hole.
//
// KNOWN, MEASURED LIMIT of that content boundary: CommonMark INDENTED code
// blocks (4-space/tab) are not modeled, so a task-shaped row inside one would
// be recognized as a declaration (Codex P2, PR #262 round 7). Declined here
// with measurement: the corpus holds ZERO task-shaped rows at >=4-space indent
// in ANY role — no illustrations to screen and no real declarations to
// protect. Every local fix trades worse: capping recognizer indent at <=3
// splits "what is a task row" between this parser and the omission oracle
// (the divergent-copies fork the shared recognizer exists to prevent), and
// masking indented chunks without tracking list context blanks legitimate
// list-item continuations. Correct handling needs a real CommonMark
// tokenizer at the content boundary — owned by the gate-hardening sweep's
// fence-tracker unification, where fences, inline spans, escaping, and
// indented code become one tokenizer instead of four hand-rolled layers.
export function taskHeaderMatches(text) {
  return [
    ...text.matchAll(new RegExp(String.raw`^#####\s+(${TASK_ID_SHAPE})\b`, "gm")),
    ...text.matchAll(
      new RegExp(String.raw`^[ \t]*-\s+(?:\[[ xX]\]\s+)?\*\*(${TASK_ID_SHAPE})\b`, "gm"),
    ),
  ];
}

// Declared task ids for a phase's `#### Tasks` block — sorted, unique.
// Gate 3's set-comparison treats every spelling above as equivalent.
export function extractDeclaredTaskIds(phaseSection) {
  const block = extractTasksBlock(phaseSection);
  if (block === null) return [];
  return [...new Set(taskHeaderMatches(block).map((m) => m[1]))].sort();
}

// --- Invariant-reference resolution (Gate 4's unresolved half) ---
//
// `**Verifies invariant:**` payloads parse to `plan-local-id` anchors, and
// verifyAnchorAgainstSpec passes every one of them trivially on the stated
// grounds that a plan-local id has "no external document to verify". That
// premise splits in two, and only one half is true:
//
//   C5 / P3 / I5   genuinely plan-local — nothing outside the plan to check.
//   I-024-4        names Plan-024 IN ITS OWN BYTES.
//
// So the structured references — 737 id-mentions across 567 marker lines —
// were accepted without anything confirming the invariant they name exists.
//
// The discriminator below is that PROPERTY ("does this id encode an owning
// document?"), never a list of accepted spellings. A shape enumeration is what
// misses the next spelling somebody invents; this is the same argument that
// made the Gate-4 complement a subtraction over positions rather than a match
// against heading shapes.
const OWNING_INVARIANT_ID_RE = /^I-(\d{3})-\d+(?:-\d+)*$/;

// The STRUCTURED-INVARIANT NAMESPACE: an `I-` id carrying a PLAN SEGMENT — digits
// followed by a further `-` or a `..`. Every id in this namespace claims to name
// an owning document, so every id in it must either resolve or produce a finding;
// that claim is the discriminator, exactly as at OWNING_INVARIANT_ID_RE, and it is
// what keeps the resolver's fail-closed arm off the plan-local shapes it has no
// business judging.
//
// Deliberately WIDER than OWNING_INVARIANT_ID_RE, which is the whole point: these
// sit inside the namespace, outside the owning shape, and returned SILENTLY — each
// one an unresolved reference that passed an armed survey.
//   I-024-1..5      the range spelling PLAN_LOCAL_ID_RE explicitly accepts
//   I-024..025-1    a range in the PLAN segment
//   I-24-3          a two-digit plan segment, one keystroke from I-024-3
//   I-008-          a plan segment with no invariant number after it
//
// Deliberately NARROWER than "starts with `I-`". A single-segment `I-1` encodes no
// owning document at all — it is the dashed spelling of the plan-local `In` form
// PLAN_LOCAL_ID_RE accepts alongside `Pr-n` — so it stays on the plan-local arm
// where it has always been. Zero live instances either way (measured: all 233
// distinct ids in `Verifies invariant` fields carry the owning shape).
const STRUCTURED_INVARIANT_NAMESPACE_RE = /^I-\d+(?:-|\.\.)/;

// A structured invariant reference may name a RANGE. `parseCitePayload` advertises
// the spelling in its own remediation text (`I-NNN-N..M (structured invariant
// range)`) and PLAN_LOCAL_ID_RE accepts it, so a range arrives at the resolver as
// an ordinary `plan-local-id` anchor whose id simply misses the owning shape.
//
// A range is a claim about EVERY id it spans, so it is expanded and each member is
// resolved on its own: `I-024-999..1000` names two undeclared invariants and must
// report two, not pass because the token happened to contain a `..`.
//
// The range sits on the LAST segment, which is where a plan numbers its invariants
// (`I-006-2-01..12` spans Plan-006's second family). Zero-padding follows the START
// endpoint's literal width, so `01..12` expands to the zero-padded spellings
// Plan-006 actually declares while `1..12` expands to unpadded ones. padStart never
// truncates, so a widening range (`1..10`) expands correctly under either rule.
const OWNING_INVARIANT_RANGE_RE = /^I-(\d{3})-((?:\d+-)*)(\d+)\.\.(\d+)$/;

// Expansion ceiling. A range is authored by hand across a handful of adjacent
// invariants; a four-digit span is a typo (`I-024-1..9999`), and expanding it would
// bury the real defect under thousands of undeclared-member findings. Above the
// ceiling the range is reported as malformed — one finding, naming the span.
const INVARIANT_RANGE_MEMBER_CEILING = 64;

/**
 * Classify one structured-invariant reference for resolution.
 *
 * Exported and separately tested for the same reason as `facetBaseId`: the live
 * corpus contains ZERO range references (measured across all 233 distinct ids in
 * `Verifies invariant` fields), so every branch here is unobservable against real
 * plans and a wrong one would look correct forever.
 *
 * @returns `{ kind: "plan-local" }` for an id that names no owning document,
 *   `{ kind: "members", ids }` for a single id or an expanded range, or
 *   `{ kind: "malformed", reason }` for anything inside the structured namespace
 *   that neither shape accepts — never a silent skip.
 */
export function classifyInvariantReference(id) {
  if (OWNING_INVARIANT_ID_RE.test(id)) return { kind: "members", ids: [id] };
  if (!STRUCTURED_INVARIANT_NAMESPACE_RE.test(id)) return { kind: "plan-local" };
  const range = OWNING_INVARIANT_RANGE_RE.exec(id);
  if (range === null) {
    return {
      kind: "malformed",
      reason:
        "it is neither `I-NNN-M` (a three-digit plan segment) nor `I-NNN-…-A..B` (a range on the last segment)",
    };
  }
  const [, planNumber, leadingSegments, startText, endText] = range;
  const start = Number(startText);
  const end = Number(endText);
  if (end < start) {
    return { kind: "malformed", reason: `the range ends at ${endText} but starts at ${startText}` };
  }
  const span = end - start + 1;
  if (span > INVARIANT_RANGE_MEMBER_CEILING) {
    return {
      kind: "malformed",
      reason: `the range spans ${span} invariants, past the ${INVARIANT_RANGE_MEMBER_CEILING}-member ceiling — ranges are authored across adjacent ids, so this is a typo, not a citation`,
    };
  }
  const ids = [];
  for (let member = start; member <= end; member += 1) {
    ids.push(`I-${planNumber}-${leadingSegments}${String(member).padStart(startText.length, "0")}`);
  }
  return { kind: "members", ids };
}

// No id matching THIS pattern carries a trailing letter, because
// PLAN_LOCAL_ID_RE ends at `$` with no letter allowed — a facet-suffixed id
// (`I-008-7c`) never becomes an anchor at all. Facets are handled instead by
// the roll-up at FACET_INVARIANT_HEAD_RE, which reads them out of `failures`.
//
// A correction worth keeping, because the wrong version of it survived a
// review: an earlier comment here explained facet invisibility by that
// rejection path. The rejection is real, but it was NOT the operative cause —
// every facet in the corpus lives in Plan-008, which carries zero bold markers,
// so its ids never reached the bold extractor to BE rejected. Right conclusion,
// wrong mechanism; the same class as a comment describing a branch that turned
// out to be dead. Corpus shape: 7 distinct facet spellings across 24 `.md`
// occurrences (21 under docs/plans/), all bases declared, exactly one in field-
// VALUE position (Plan-008:370, task `T-008r-1-4`).

// Test-tier ids from a plan's `## Test And Verification Plan` tables (`I5`)
// share the `I` prefix with invariant ids and carry NO plan segment. They are
// declared — as TESTS — so a reference to one is a namespace collision, not a
// dangling pointer, and the message has to say so: "undeclared invariant" sends
// the next author hunting for a declaration that should never exist, and the
// obvious way to silence it is to mint a fake invariant id. Live instance:
// Plan-001:393 + :709 spelled `I5` where the line's own Files and Spec-coverage
// fields both already say `I-024-4`. Three plans (001, 002, 003) carry `I<n>`
// test tables; only 001 leaked one into an invariant field.
//
// The optional `..N` tail keeps the range spelling on THIS arm rather than
// letting `I5..7` fall through to the same silence the structured range fix
// closes one branch over — same defect class, same function, and it only selects
// which message an already-returning branch prints.
const PLAN_LOCAL_TEST_ID_RE = /^I\d+(?:\.\.\d+)?$/;

// The declaration grammars, all four observed spellings across three patterns.
// Measured against the corpus rather than assumed — a bolded table row is live
// here, so a pattern requiring a bare `| I-NNN-N |` under-counts silently.
//
//   A. heading      `### I-008-7 — Control-plane …`
//   B. bullet+bold  `- **I-006-4-01 — …**`
//   C. table row    `| I-021-7 | …`   and   `| **I-021-7** | …`
//
// Each anchors the id at a structural position (heading marker, bullet bold
// open, first table cell) so a prose mention of an id cannot declare it.
const INVARIANT_ID_SHAPE = String.raw`I-\d{3}-\d+(?:-\d+)*`;

function invariantDeclarationMatches(text) {
  return [
    ...text.matchAll(new RegExp(String.raw`^#{2,5}\s+(${INVARIANT_ID_SHAPE})\b`, "gm")),
    ...text.matchAll(new RegExp(String.raw`^[ \t]*-\s+\*\*(${INVARIANT_ID_SHAPE})\b`, "gm")),
    ...text.matchAll(new RegExp(String.raw`^\|\s*\**\s*(${INVARIANT_ID_SHAPE})\**\s*\|`, "gm")),
  ];
}

// The `## Invariants` block, masked. Bound is the NESTED reading — to the next
// heading of the SAME-OR-HIGHER level (`#` or `##`) — so the `### I-NNN-M`
// heading grammar stays INSIDE its own block instead of terminating it at the
// first declaration.
export function extractInvariantsBlock(planSource) {
  const masked = maskNonContentLines(planSource);
  const heading = /^##\s+Invariants\s*$/m.exec(masked);
  if (!heading) return null;
  const from = heading.index + heading[0].length;
  const rest = masked.slice(from);
  const next = /^#{1,2}\s+\S/m.exec(rest);
  return rest.slice(0, next ? next.index : rest.length);
}

// Declared invariant ids for one plan — sorted, unique.
//
// Returns `hasBlock` alongside the ids because the two zero-cases are NOT the
// same and must not resolve the same way. A plan with no `## Invariants` block
// declares nothing (references to it are undeclared). A plan WITH a block that
// parses to zero ids means the extractor failed to recognize a shape — and
// reporting every reference to that plan as "undeclared" would bury one
// extractor defect under a flood of wrong findings pointing at innocent lines.
// The caller reports the block once and resolves nothing against it. Returning
// a bare `[]` for both is the CAT-10 shape this gate exists to close.
export function extractDeclaredInvariantIds(planSource) {
  const block = extractInvariantsBlock(planSource);
  if (block === null) return { ids: [], hasBlock: false };
  const ids = [...new Set(invariantDeclarationMatches(block).map((m) => m[1]))].sort();
  return { ids, hasBlock: true };
}

// --- Size classification (design memo §5, 2026-07-06 refinement) ---
// S: ≤1 declared task. M: 2-3 tasks whose Files: paths sit in one top-level
// packages/<name> | apps/<name> root (non-code paths don't count against it).
// L: everything else. Drives G4 strictness here and the ceremony map in
// SKILL.md § Size-Classed Ceremony; Codex + CI are invariant across classes.
export function classifyPhaseSize(declaredTaskIds, targetPaths) {
  // FAIL CLOSED on zero parsed IDs: an empty list means the extractor did not
  // recognize the Tasks-block shape (not that the phase is small) — classify L
  // so an unrecognized future shape gets the FULL ceremony, never a skipped
  // reviewer set + demoted G4 (Codex P1, PR #190).
  if (declaredTaskIds.length === 0) return "L";
  if (declaredTaskIds.length <= 1) return "S";
  if (declaredTaskIds.length <= 3) {
    // FAIL CLOSED on zero parsed paths (mirror of the zero-IDs rule above):
    // with no Files: targets parsed, single-root confinement is UNPROVEN —
    // M is earned only by parsed paths sitting in at most one code root
    // (docs-only phases keep M: paths parsed, none code). Codex, PR #190:
    // Plan-021 Phase 4 has three task rows with no Files: fields.
    if (targetPaths.length === 0) return "L";
    // Docs-ish paths (docs/ tree, *.md anywhere) are the ONLY exempt class.
    // Repo-tooling / infra CODE outside packages|apps (.claude/, tools/,
    // .github/, scripts/) is not covered by M's single-package-root grant —
    // fail closed to L rather than awarding M on zero counted roots
    // (Codex, PR #190).
    const nonExempt = targetPaths.filter(
      (p) => !/^docs\//.test(p) && !/\.md$/.test(p) && !/^(packages|apps)\//.test(p),
    );
    if (nonExempt.length > 0) return "L";
    const roots = new Set();
    for (const p of targetPaths) {
      // A wildcard in the root-name position (`packages/*/src/index.ts`) can
      // span every package — it can never prove single-root confinement, so
      // it fails closed to L instead of counting as one root (Codex, PR #190).
      if (/^(packages|apps)\/[^/]*\*/.test(p)) return "L";
      // (\/|$) — a bare `packages/a` (no trailing slash) is still that root
      // (Codex, PR #190: `Files: packages/a, apps/b` counted zero roots → M).
      const m = /^(packages\/[^/]+|apps\/[^/]+)(\/|$)/.exec(p);
      if (m) roots.add(m[1]);
    }
    if (roots.size <= 1) return "M";
  }
  return "L";
}

// Files: extractor over both audit-Tasks-block layouts (sub-header bold field
// + parenthesized inline). Path-shaped tokens only; dedup, order-stable.
export function extractDeclaredFilePaths(phaseSection) {
  const paths = [];
  // Capture the whole line, then truncate at the first KNOWN metadata marker —
  // not at every `;` (audited rows also use semicolons BETWEEN paths: `x.ts
  // (NEW); apps/b/y.ts (EXTEND)`), and not at the first `)` (inline
  // annotations like `a.ts (CREATE) + b.ts` would drop the second root). An
  // unknown future marker leaks its path-shaped tokens into the target list,
  // which can only widen the root set — the fail-closed direction (Codex ×2,
  // PR #190).
  const fieldRe = /\bFiles:\s*([^\n]+)/g;
  // Two marker shapes end the clause: `; Label:` (inline rows) and `**Label`
  // (sub-header rows whose fields share one line) — without the bold stop,
  // cite prose after `**Spec coverage:**` leaks slash-shaped tokens like
  // `20/session/hr` into the target list, turning a should-be-fail-closed-L
  // phase into M via nonzero non-code paths (Codex, PR #190).
  const fieldLabels =
    "Spec coverage|Verifies invariant|Consumes|Provides|Wires|Acceptance|Depends on|Rollback";
  const metadataMarker = new RegExp(`;\\s*(?:${fieldLabels})\\s*:|\\*\\*\\s*(?:${fieldLabels})`);
  let m;
  while ((m = fieldRe.exec(phaseSection)) !== null) {
    const markerHit = metadataMarker.exec(m[1]);
    const clause = markerHit ? m[1].slice(0, markerHit.index) : m[1];
    for (const token of clause.split(/[,\s]+/)) {
      // Trailing sentence punctuation (`pty-host.ts\`.`) would fail the path
      // regex and silently drop the package root from classification. Markup
      // strip is EDGE-anchored so glob stars inside a path survive.
      const cleaned = token
        .replace(/^[`*([]+/, "")
        .replace(/[`*.,;:!?)\]]+$/, "")
        .trim();
      // Path-shaped = 2+ slash-joined segments (files, directories with a
      // trailing slash, globs — a directory target like
      // `packages/runtime-daemon/src/ipc/handlers/` is root-bearing evidence
      // even without an extension) OR a slash-less root-level file with an
      // extension (`package.json`) — dropping those hid root tooling/config
      // targets from the fail-closed non-exempt check (Codex, PR #190).
      const pathShaped =
        /^[\w.@-]+(\/[\w.@*-]+)+\/?$/.test(cleaned) ||
        /^[\w@-][\w.@-]*\.\w+$/.test(cleaned) ||
        // Extensionless root config/tooling files: dotfiles (.nvmrc,
        // .gitignore) and the well-known bare names — dropping them hid
        // repo-root tooling targets from the fail-closed check (Codex, PR #190).
        /^\.[\w.-]+$/.test(cleaned) ||
        /^(?:Dockerfile|Makefile|Justfile|Procfile|Brewfile|Vagrantfile|LICENSE|NOTICE|CODEOWNERS)$/.test(
          cleaned,
        ) ||
        // Single-segment directories (`tools/`) and the bare root tooling dir
        // names — a directory-valued repo-root target must reach the
        // fail-closed non-exempt check (Codex, PR #190).
        /^[\w.@-]+\/$/.test(cleaned) ||
        /^(?:tools|scripts)$/.test(cleaned);
      if (pathShaped && !paths.includes(cleaned)) paths.push(cleaned);
    }
  }
  return paths;
}

// Extract §5 (Canonical Build Order) from cross-plan-dependencies.md. Used by
// the cross_plan_carve_out and audit_status:substrate_exempt resolvers to
// scope membership checks to §5 only — pre-fix cross_plan_carve_out used a
// bare `source.includes(ref)` substring match, which passed when the ref
// appeared anywhere in the file (e.g., §3 prose, §6 NS-rows) even if §5 had
// no entry. Returns the §5 slice (from its heading line through the
// character before the next `^## ` heading), or null when §5 is missing.
//
// Heading shape supports both `## 5. Canonical Build Order` (dot-then-space
// form — the current shape) and `## Section 5 — ...` (defensive alternative).
// The `\b` lives inside the `Section 5` alternative only: putting it after
// `5\.` would look for a word boundary between `.` (non-word) and ` `
// (non-word) and fail to match.
export function extractSection5(xplanSource) {
  const startRe = /^##\s+(?:5\.\s|Section\s+5\b).*$/m;
  const startMatch = startRe.exec(xplanSource);
  if (!startMatch) return null;
  const startIdx = startMatch.index;
  const after = xplanSource.slice(startIdx + startMatch[0].length);
  const nextRe = /^##\s+/m;
  const nextMatch = nextRe.exec(after);
  const endIdx = nextMatch ? startIdx + startMatch[0].length + nextMatch.index : xplanSource.length;
  return xplanSource.slice(startIdx, endIdx);
}

// Extract a single backlog item's section — its `### BL-NNN` / `#### BL-NNN`
// heading (active backlog uses h3, the archive uses h4) through the line before
// the next ATX heading or `---` horizontal rule — or null if the item heading
// is absent. Heading-anchored (not a bare substring) with the same
// scoped-not-loose rigor as extractSection5: a `[BL-NNN](…)` cross-reference or
// a mention inside a neighbor item's prose must not be mistaken for the item
// itself, so the Status read in the bl_closed resolver comes only from the
// item's own block. `\b` after the id rejects longer-number collisions
// (BL-140 must not match a BL-1400 heading).
export function extractBacklogItemSection(source, blId) {
  const lines = source.split("\n");
  const headingRe = new RegExp(`^#{2,4}\\s+${blId}\\b`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+\S/.test(lines[i]) || /^---\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// Judge whether a backlog item's section (as returned by
// extractBacklogItemSection) represents work that actually landed: its Status
// line must read `completed`. Returns { ok: true } or { ok: false, reason }
// where reason is "unparseable" or the lowercased non-completed status. Shared
// by the bl_closed resolver's active-backlog AND archive paths so the two
// cannot drift — the archive is NOT a completed-only location (e.g. BL-136 is
// `withdrawn` there), so heading presence in the archive must never by itself
// imply the dependency closed (Codex P2 on PR #138).
function judgeBacklogCompletion(section) {
  const statusMatch = section.match(/^[-*]\s*Status:\s*`?(\w+)`?/m);
  if (!statusMatch) return { ok: false, reason: "unparseable" };
  const status = statusMatch[1].toLowerCase();
  if (status === "completed") return { ok: true };
  return { ok: false, reason: status };
}

// Extract the set of task ids shipped for a given phase from the parsed
// manifest. Single-string `task` and array-form `task` (legacy multi-task
// PRs predating NS-02) both contribute their ids. Returns a Set.
export function shippedTaskIdsForPhase(manifest, phaseNumber) {
  const out = new Set();
  if (!manifest || !manifest.ok) return out;
  for (const e of manifest.shipped) {
    if (e.phase !== phaseNumber) continue;
    if (Array.isArray(e.task)) for (const t of e.task) out.add(t);
    else if (typeof e.task === "string" && e.task.trim() !== "") out.add(e.task);
  }
  return out;
}

// ---------- IO layer (stubbable) ----------

let _ghImpl = (cmd) => execSync(cmd, { encoding: "utf8", cwd: REPO_ROOT });

export function setGhImpl(impl) {
  _ghImpl = impl;
}
export function resetGhImpl() {
  _ghImpl = (cmd) => execSync(cmd, { encoding: "utf8", cwd: REPO_ROOT });
}

function runGh(cmd) {
  try {
    return { ok: true, out: _ghImpl(cmd) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// ---------- gates ----------

export function gateProjectLocality({ repoRoot = REPO_ROOT, skillMd = SKILL_MD } = {}) {
  let skillSource;
  try {
    skillSource = readFileSync(skillMd, "utf8");
  } catch (e) {
    return {
      ok: false,
      halt: `## Preflight halt: skill SKILL.md unreadable\n\n${skillMd}: ${e.message}`,
    };
  }
  const fm = parseFrontmatter(skillSource);
  const required = fm.requires_files || [];
  if (required.length === 0) return { ok: true };
  const missing = required.filter((p) => !existsSync(resolve(repoRoot, p)));
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    halt: [
      "## Preflight halt: project-locality",
      "",
      "The plan-execution skill expects an ai-sidekicks-shaped repo with these files:",
      ...required.map((p) => `  - ${p}`),
      "",
      "Missing from this repo:",
      ...missing.map((p) => `  - ${p}`),
      "",
      "Re-run from a repo with these surfaces, or fork the skill and amend the",
      "`requires_files:` frontmatter at .claude/skills/plan-execution/SKILL.md.",
    ].join("\n"),
  };
}

// Top-level audit-completeness gate. Lenient by design: passes when EITHER
// the plan-level checkbox is ticked OR any phase declares per-phase
// audit_status (the substrate-vs-namespace carve-out path). The strict
// per-phase enforcement happens inside _checkPhase via gatePhaseAuditCheckbox
// after the target phase is resolved — top-level lenience is what lets
// Plan-023's Phase 1 dispatch even though Tier 8 remainder phases haven't
// been authored with audit_status YAML yet. See docs/operations/
// plan-implementation-readiness-audit-runbook.md §Per-Phase Audit Semantics.
export function gateAuditCheckbox(planSource, planFile) {
  if (extractAuditCheckbox(planSource)) return { ok: true };
  if (/type:\s*audit_status\b/.test(planSource)) return { ok: true };
  return {
    ok: false,
    halt: [
      "## Preflight halt: audit-complete gate failed",
      "",
      `Plan ${planFile} has no plan-level audit-complete checkbox AND no phase`,
      `declares a per-phase \`audit_status\` precondition. The Status Promotion`,
      `Gate from docs/operations/plan-implementation-readiness-audit-runbook.md`,
      `blocks code-execution dispatch on un-audited plans.`,
      "",
      "Either complete the plan-readiness audit (runbook procedure) and tick the",
      "checkbox, OR declare an `audit_status` precondition entry on the phase",
      "being dispatched (runbook §Per-Phase Audit Semantics).",
    ].join("\n"),
  };
}

// Gate 6 — manifest freshness. Plan-level: numbered by accretion order (Gates
// 1-5 keep their historical numbers — docs, tests, and halt messages reference
// them by number), but EXECUTED between Gate 2 and the per-phase walk, because
// a stale manifest corrupts Gate 3's declared-vs-shipped set comparison (a
// merged-but-unrecorded shipment re-opens an already-shipped phase).
//
// This is NOT a return to the pre-Commit-3 gh-search shipment inference that
// the manifest refactor removed (see preflight-contract.md §Gate 3 "Why
// manifest set-comparison, not gh search"). The manifest remains the sole
// authority for phase selection; gh is consulted only to cross-check manifest
// COMPLETENESS — the BL-110 doctrine that ground truth stays git and the
// manifest is a cache. Three deliberate narrowings keep the old false-match
// classes out: (1) `in:title` only — never `in:title,body` (PR bodies cite
// plans in passing constantly; titles cite the plan they ship for — empirical
// sweep 2026-07-06: title-search precision was exact across all 27 plans);
// This recall trade IS the enhancement-lane boundary (CONTRIBUTING.md §How Code
// Lands): lane-2 enhancement and lane-3 tooling PRs deliberately omit the token,
// so they are invisible to this gate BY DESIGN — only lane-1 plan-task shipments
// participate in manifest freshness.
// (2) only PRs whose diff touches a MATERIAL_PATH_PREFIXES path count —
// packages/ + apps/ are the ownership map's code families, .github/ covers
// workflow-only shipments (Plan-024 T-024-4-1 ships sidecar-build.yml alone;
// Codex P2 on PR #182), and deploy/ covers self-host compose shipments
// (Plan-025 T-025d-14-1 ships deploy/self-host/* alone — formerly the G6
// blind spot). The inverted form (material = anything outside docs/)
// was rejected on corpus evidence: governance PRs whose titles cite plans also
// touch root files (PR #1 ships .gitignore/README.md/AGENTS.md under a
// Plan-001 title), so exclude-docs would permanently false-halt Plan-001;
// (3) a missing entry HALTS
// with the rebuild tool as remediation — the gate never derives or writes
// manifest entries itself (rebuild's operator-confirmation model owns phase /
// task attribution ambiguity).
//
// Fail-closed contract (ADR-023 gate-vs-detector discipline: gates fail
// closed, detectors warn): gh unreachable, malformed output, fetch
// saturation, and file-list truncation all HALT rather than pass. The
// explicit CLI escape is --allow-stale-manifest (skip is logged to stderr).
export const FRESHNESS_FETCH_LIMIT = 100;
// Sync contract: tools/docs-corpus/bin/lane-boundary-check.ts mirrors this
// constant (the CI lane guard must classify "material" exactly as G6 does);
// a deep-equality test in tools/docs-corpus/__tests__/lane-boundary-check.test.ts
// fails CI on divergence.
export const MATERIAL_PATH_PREFIXES = ["packages/", "apps/", ".github/", "deploy/"];

export function gateManifestFreshness(planSource, planNumber) {
  const manifest = parseManifestBlock(planSource);
  // Structural manifest defects halt in Gate 3 with richer remediation text;
  // freshness only cross-checks a manifest that already parses. Future-schema
  // manifests stay opaque per the lib/manifest.mjs fail-open policy.
  if (!manifest.ok) return { ok: true, reason: "deferred_to_gate3" };
  if (manifest.version > MANIFEST_SCHEMA_VERSION) {
    return { ok: true, reason: "manifest_future_schema" };
  }
  const manifestPrs = new Set(manifest.shipped.map((entry) => entry.pr));
  const paddedPlan = String(planNumber).padStart(3, "0");
  const listRun = runGh(
    `gh pr list --state merged --search "Plan-${paddedPlan} in:title" ` +
      `--json number,title,mergedAt --limit ${FRESHNESS_FETCH_LIMIT}`,
  );
  if (!listRun.ok) return ghUnreachableHalt(paddedPlan, listRun.error);
  let merged;
  try {
    merged = JSON.parse(listRun.out);
  } catch (e) {
    return ghMalformedHalt(paddedPlan, `gh pr list output is not JSON: ${e.message}`);
  }
  if (!Array.isArray(merged)) {
    return ghMalformedHalt(paddedPlan, "gh pr list output is not a JSON array");
  }
  if (merged.length === FRESHNESS_FETCH_LIMIT) {
    return {
      ok: false,
      kind: "freshness_fetch_saturated",
      halt: [
        "## Preflight halt: manifest-freshness fetch saturated (Gate 6)",
        "",
        `gh pr list returned exactly ${FRESHNESS_FETCH_LIMIT} matches for`,
        `"Plan-${paddedPlan} in:title" — the result MAY be truncated, so manifest`,
        "completeness cannot be cross-checked. Raise FRESHNESS_FETCH_LIMIT in",
        "preflight.mjs (mirroring rebuild-shipment-manifest.mjs's FETCH_LIMIT",
        "anti-silent-truncation discipline) and re-run.",
      ].join("\n"),
    };
  }
  const stale = [];
  for (const pullRequest of merged) {
    if (manifestPrs.has(pullRequest.number)) continue;
    const viewRun = runGh(`gh pr view ${pullRequest.number} --json files,changedFiles`);
    if (!viewRun.ok) return ghUnreachableHalt(paddedPlan, viewRun.error);
    let details;
    try {
      details = JSON.parse(viewRun.out);
    } catch (e) {
      return ghMalformedHalt(
        paddedPlan,
        `gh pr view ${pullRequest.number} output is not JSON: ${e.message}`,
      );
    }
    const files = Array.isArray(details.files) ? details.files : [];
    if (typeof details.changedFiles === "number" && files.length < details.changedFiles) {
      return {
        ok: false,
        kind: "freshness_files_truncated",
        halt: [
          "## Preflight halt: manifest-freshness file list truncated (Gate 6)",
          "",
          `gh pr view ${pullRequest.number} returned ${files.length} of`,
          `${details.changedFiles} changed files — the GraphQL files(first: 100)`,
          "ceiling truncated the list, so the material-path classification for",
          `PR #${pullRequest.number} cannot be trusted (mirrors`,
          "rebuild-shipment-manifest.mjs exit-7 discipline). Classify the PR",
          "manually, reconcile the manifest, and re-run — or bypass explicitly",
          "with --allow-stale-manifest.",
        ].join("\n"),
      };
    }
    const materialFileCount = files.filter(
      (f) =>
        typeof f.path === "string" &&
        MATERIAL_PATH_PREFIXES.some((prefix) => f.path.startsWith(prefix)),
    ).length;
    if (materialFileCount > 0) {
      stale.push({
        number: pullRequest.number,
        title: pullRequest.title,
        mergedAt: pullRequest.mergedAt,
        materialFileCount,
      });
    }
  }
  if (stale.length === 0) return { ok: true };
  return {
    ok: false,
    kind: "manifest_stale",
    stale,
    halt: [
      "## Preflight halt: shipment manifest is stale (Gate 6 — manifest freshness)",
      "",
      `Plan-${paddedPlan}'s ### Shipment Manifest has no entry for ${stale.length} merged`,
      `material PR(s) whose title cites Plan-${paddedPlan} (diff touches`,
      `${MATERIAL_PATH_PREFIXES.join(" / ")}):`,
      "",
      ...stale.map(
        (p) =>
          `  - PR #${p.number} (merged ${String(p.mergedAt ?? "").split("T")[0]}, ` +
          `${p.materialFileCount} material file(s)): ${p.title}`,
      ),
      "",
      "Gate 3 selects the next phase by comparing declared tasks against this",
      "manifest; a missing entry can re-open an already-shipped phase and",
      "re-dispatch completed work. Ground truth stays git — the manifest is the",
      "cache (BL-110). Reconcile, then re-run preflight:",
      "",
      "  node --experimental-strip-types \\",
      "    .claude/skills/plan-execution/scripts/rebuild-shipment-manifest.mjs \\",
      `    --plan ${paddedPlan} --dry-run`,
      "",
      "Inspect the emitted entries, resolve operator-confirmation ambiguities",
      "(phase/task attribution), apply them to the plan file, and land the",
      "manifest edit through a PR. Emergency bypass (gh outage / offline):",
      "re-run preflight with --allow-stale-manifest (skip is logged to stderr).",
    ].join("\n"),
  };
}

function ghUnreachableHalt(paddedPlan, error) {
  return {
    ok: false,
    kind: "freshness_gh_unreachable",
    halt: [
      "## Preflight halt: manifest-freshness cross-check unavailable (Gate 6)",
      "",
      `gh failed while cross-checking Plan-${paddedPlan}'s manifest against merged`,
      `PRs: ${error}`,
      "",
      "Gate 6 fails closed (ADR-023 gate discipline): a manifest that cannot be",
      "cross-checked is treated as potentially stale rather than silently",
      "trusted. Fix gh (auth/network) and re-run, or bypass explicitly with",
      "--allow-stale-manifest (skip is logged to stderr).",
    ].join("\n"),
  };
}

function ghMalformedHalt(paddedPlan, detail) {
  return {
    ok: false,
    kind: "freshness_gh_malformed",
    halt: [
      "## Preflight halt: manifest-freshness cross-check unavailable (Gate 6)",
      "",
      `Unexpected gh output while cross-checking Plan-${paddedPlan}'s manifest:`,
      detail,
      "",
      "Gate 6 fails closed. Investigate the gh installation / API response and",
      "re-run, or bypass explicitly with --allow-stale-manifest.",
    ].join("\n"),
  };
}

// Strict per-phase audit gate, called inside _checkPhase after the target
// phase has been resolved. Passes when EITHER the plan-level checkbox is
// ticked OR THIS phase declares `type: audit_status` in its preconditions
// block. Pre-this-PR Gate 2 was plan-scoped (any checkbox anywhere); after
// the per-phase migration, a phase shipping under a substrate carve-out
// must carry its own audit_status YAML to admit itself for dispatch — a
// plan-level fail-open path would let Plan-023 Phase 2+ (Tier 8 remainder,
// not yet authored) dispatch through the lenient top-level OR-check.
export function gatePhaseAuditCheckbox(planSource, phaseSection, planFile, phaseNumber) {
  if (extractAuditCheckbox(planSource)) return { ok: true };
  if (/type:\s*audit_status\b/.test(phaseSection ?? "")) return { ok: true };
  return {
    ok: false,
    halt: [
      "## Preflight halt: per-phase audit declaration missing",
      "",
      `Plan ${planFile} has no plan-level audit-complete checkbox AND Phase`,
      `${phaseNumber} declares no \`audit_status\` precondition entry. The Status`,
      `Promotion Gate requires every dispatched phase to carry either the`,
      `plan-level audit-complete checkbox OR an explicit per-phase`,
      `\`audit_status\` declaration (runbook §Per-Phase Audit Semantics).`,
      "",
      "Either complete the plan-readiness audit and tick the plan-level checkbox,",
      "OR declare an `audit_status` precondition entry on this phase. Two values",
      "are permitted: `complete` (with evidence_pr + baseline_tag) or",
      "`substrate_exempt` (with carve_out_ref pointing to a §5 carve-out entry in",
      "docs/architecture/cross-plan-dependencies.md).",
    ].join("\n"),
  };
}

// Classify whether a phase has fully shipped. Shared by Gate 3 (this plan)
// and Gate 5 plan_phase resolver (upstream plan). Ordering is load-bearing:
// the manifest parse + version-future check fire BEFORE any structural
// inspection of the phase section, so a future v2 manifest that reshapes
// phase headings still fail-opens (treat-as-opaque semantic) instead of
// halting with "section not found".
//
// Result kinds:
//   - manifest_unparseable: parseManifestBlock returned !ok. Halt; this is
//     the loud-failure replacement for the silent-pass behavior Codex
//     flagged on PR #35 round 7 (a malformed manifest would otherwise
//     re-open Gate 3 and re-dispatch already-shipped phases).
//   - manifest_invalid_entries: parseManifestBlock returned ok but at least
//     one shipped[] entry fails validateEntry. Halt; pre-round-8 the
//     classifier trusted parseManifestBlock and read fields directly, so
//     type/shape errors (e.g. `phase: "5"` as string, missing `task`,
//     unknown field names) silently produced an incomplete shipped-tasks
//     set and re-opened Gate 3 (Codex P2 finding on PR #35 round 8).
//   - manifest_future_schema: version > MANIFEST_SCHEMA_VERSION. Fail open
//     per lib/manifest.mjs schema-version policy.
//   - no_phase_section: the requested phase isn't declared in the plan.
//   - no_declared_tasks: phase exists but its #### Tasks block has no task
//     ids in either the sub-header (`##### T1.1`) or bullet+bold
//     (`- **T-007p-1-1**`) form.
//   - partially_shipped: at least one declared task isn't in the shipped
//     set. Carries `missing` so callers can render diagnostics.
//   - fully_shipped: every declared task appears in the shipped set.
export function classifyPhaseShipment(planSource, phaseNumber) {
  const manifest = parseManifestBlock(planSource);
  if (!manifest.ok) return { kind: "manifest_unparseable", reason: manifest.reason };
  if (manifest.version > MANIFEST_SCHEMA_VERSION) {
    return { kind: "manifest_future_schema", version: manifest.version, manifest };
  }
  // Schema-validate every shipped[] entry before reading fields. Skipping this
  // would let `phase: "5"` (string) silently miss the `e.phase === phaseNumber`
  // check, dropping that entry from the shipped-tasks set and re-opening
  // Gate 3 for an already-shipped phase. Halt loudly with a per-index error
  // list instead.
  const entryErrors = [];
  for (let i = 0; i < manifest.shipped.length; i++) {
    const v = validateEntry(manifest.shipped[i]);
    if (!v.ok) entryErrors.push({ index: i, errors: v.errors });
  }
  if (entryErrors.length > 0) {
    return { kind: "manifest_invalid_entries", entryErrors, manifest };
  }
  const sec = extractPhaseSection(planSource, phaseNumber);
  if (!sec) return { kind: "no_phase_section", manifest };
  const declared = extractDeclaredTaskIds(sec);
  const phaseHasManifestEntry = manifest.shipped.some((e) => e.phase === phaseNumber);
  if (declared.length === 0) {
    return { kind: "no_declared_tasks", manifest, phaseHasManifestEntry };
  }
  const shipped = shippedTaskIdsForPhase(manifest, phaseNumber);
  const missing = declared.filter((t) => !shipped.has(t));
  if (missing.length === 0) {
    return { kind: "fully_shipped", declared, shipped: [...shipped], manifest };
  }
  return { kind: "partially_shipped", declared, shipped: [...shipped], missing, manifest };
}

// Gate 3 — phase un-shipped. Halts when the phase is fully shipped, or when
// the manifest can't be parsed (per Codex P1 finding on PR #35 round 7:
// silent fail-open on parse failure was a correctness regression in
// auto-walk mode — already-shipped phases would look unshipped after any
// manifest formatting error). Schema-version forward-compat (unknown future
// versions) remains the only intentional fail-open.
export function gatePhaseUnshipped(planSource, planNumber, phase) {
  const result = classifyPhaseShipment(planSource, phase.number);
  if (result.kind === "manifest_unparseable") {
    return {
      ok: false,
      kind: "manifest_unparseable",
      halt: [
        "## Preflight halt: shipment manifest unparseable",
        "",
        `Plan-${planNumber} has a malformed or missing ### Shipment Manifest block`,
        `(reason: ${result.reason}). Gate 3 cannot determine whether Phase ${phase.number}`,
        `("${phase.title}") is already shipped, so it halts rather than risk re-dispatching`,
        `a completed phase (Codex P1 finding on PR #35 round 7).`,
        "",
        "Reasons returned by parseManifestBlock:",
        "  - no_section: ### Shipment Manifest heading missing — plan was likely created",
        "    before the template update. Add the section per docs/plans/000-plan-template.md.",
        "  - no_yaml_fence: section exists but the ```yaml fenced block is missing or",
        "    truncated.",
        "  - missing_schema_version: fenced block exists but `manifest_schema_version: 1`",
        "    is absent.",
        "  - missing_shipped: schema-version present but the `shipped:` top-level key is",
        "    absent. Add `shipped: []` for an empty manifest, or list entries under it.",
      ].join("\n"),
    };
  }
  if (result.kind === "manifest_invalid_entries") {
    return {
      ok: false,
      kind: "manifest_invalid_entries",
      halt: [
        "## Preflight halt: shipment manifest entries fail schema validation",
        "",
        `Plan-${planNumber} ### Shipment Manifest YAML parses, but ${result.entryErrors.length}`,
        `entries fail validateEntry. Type/shape errors (e.g. \`phase: "5"\` as string,`,
        `missing \`task\`, unknown field names) silently produce an incomplete shipped-`,
        `tasks set, so Gate 3 halts to prevent re-dispatching an already-shipped phase`,
        `(Codex P2 finding on PR #35 round 8).`,
        "",
        "Per-entry errors:",
        ...result.entryErrors.flatMap((e) => [
          `  shipped[${e.index}]:`,
          ...e.errors.map((m) => `    - ${m}`),
        ]),
        "",
        "Fix the failing entries (schema authoritative in lib/manifest.mjs §validateEntry)",
        "and re-run preflight.",
      ].join("\n"),
    };
  }
  if (result.kind === "fully_shipped") {
    return {
      ok: false,
      kind: "fully_shipped",
      halt: [
        "## Preflight halt: phase already shipped",
        "",
        `Plan-${planNumber} Phase ${phase.number} ("${phase.title}") declared tasks`,
        `[${result.declared.join(", ")}] all appear in the shipment manifest. Pick the next`,
        `un-shipped phase, or override-supply a phase number for explicit-phase mode.`,
      ].join("\n"),
    };
  }
  return { ok: true };
}

// ---------- Gate 4 cite-anchor semantic verification ----------
//
// Layered on top of the existing token-presence Gate 4. The token check
// remains the floor (counts.spec_coverage / counts.verifies_invariant must
// each be ≥ 1); when present, the semantic check then parses each emitted
// cite and verifies its anchor against the named spec. Closes the
// verification side of the cite-discipline contract authored on the
// dispatch side in `docs/operations/plan-implementation-readiness-audit-runbook.md`
// §Subagent Prompt Template (post-mortem 51ca5f3d).
//
// Pipeline order is load-bearing: Unicode dashes (en-dash U+2013 `–`,
// em-dash U+2014 `—`) are normalised to ASCII `-` BEFORE tokenisation or
// pattern-match. Without this the compound-range rejection rule misses
// `lines 85–86`-shape defects (Plan-002 T3.3 form).

const UNICODE_DASH_RE = /[–—]/g;

export function normalizeCitePayload(text) {
  return text.replace(UNICODE_DASH_RE, "-");
}

// Identifier-token: CamelCase (`PresenceUpdate`), dotted (`presence.heartbeat`),
// or all-caps acronym joined via hyphen (`JSON-RPC` is matched as two tokens
// `JSON` + `RPC`, which is fine for compound-range multi-subject detection
// because we count distinct CamelCase identifiers, not acronym fragments).
const IDENTIFIER_TOKEN_RE =
  /\b([A-Z][a-zA-Z]+(?:[A-Z][a-zA-Z]*)*|[a-z][a-zA-Z]+\.[a-zA-Z][a-zA-Z.]*)\b/g;

// Plan-local row IDs span simple (`C5`, `P1`, `I1`), structured
// (`I-024-3`, `Pr-1`), and multi-invariant range (`I-024-1..5`) forms per
// Pre-3 implication 6 of the post-mortem fix plan. Used both for detecting
// Plan-local-ID-as-Spec-anchor defects AND for filtering subject candidates
// extracted from descriptors.
const PLAN_LOCAL_ID_RE = /^(?:C|P|Pr|I)-?\d+(?:\.\.\d+)?(?:-\d+(?:\.\.\d+)?)*$/;

// Plan-NNN:LLL — colon-line-number form. The discriminator from Pre-3
// implication 3: this shape is the namespace-violation defect when it
// appears inside a Spec-NNN parenthetical. `Plan-NNN §Section` (no colon)
// is the legitimate cross-plan-context shape and is NOT flagged.
const PLAN_LINE_CITE_RE = /\bPlan-\d+:\d+\b/;

export function extractIdentifierTokens(text) {
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(IDENTIFIER_TOKEN_RE)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

// Namespace prefixes (`Plan-021`, `Spec-002`, `ADR-018`) are cross-reference
// markers, not contract subjects. Strip them before identifier extraction so
// `Plan` doesn't surface as a false-positive subject when a descriptor cites
// another doc (e.g., `... per Plan-021 §RateLimitResponse canonical shape`).
const NAMESPACE_PREFIX_RE = /\b(?:Plan|Spec|ADR)-\d+\b/g;

// Subject tokens are identifier-tokens with namespace-prefix markers stripped
// (Plan-NNN/Spec-NNN/ADR-NNN) and Plan-local row IDs filtered out. Used to
// pick the "what does this anchor point at" subject from a paren descriptor
// like `(I3 — ChannelList bootstrap projection)` → ChannelList.
function nonPlanLocalSubjects(text) {
  const stripped = text.replace(NAMESPACE_PREFIX_RE, "");
  return extractIdentifierTokens(stripped).filter((t) => !PLAN_LOCAL_ID_RE.test(t));
}

// Paren-aware split on top-level segment boundaries. Two boundaries:
//   - `;` at depth 0 (canonical cross-namespace separator,
//     `Spec-001 AC8; ADR-018 §Decision #4`)
//   - `,` at depth 0 followed by another recognized namespace prefix.
//     Recognized starts: `Spec-NNN`, `ADR-NNN`, plan-local-id (`Cn`/`Pn`/
//     `Pr-n`/`In` or structured `I-NNN-N`), `none` literal, `<file>.md`,
//     `cross-plan-deps`. Without the plan-local-id branch, comma-separated
//     invariant lists (`Verifies invariant: I-024-1, I-024-2, ...` or
//     `; P1, P2, P3`) fold into a single anchor whose descriptor swallows
//     the trailing IDs and silently passes the gate (Codex P1 on PR #96
//     line 620). Longer alternations precede shorter ones so `Pr` is
//     tried before `P`.
const TOP_LEVEL_NS_LOOKAHEAD =
  /^,\s+(?:Spec-\d+|ADR-\d+|(?:Pr|C|P|I)-?\d+|none\b|[a-z][\w-]*\.md|cross-plan-deps)\b/;

// Depth tracking covers parens, square brackets, AND curly braces. The brace
// case is load-bearing because TS-object-literal descriptors like
// `{deviceType, focusedSessionId, lastActivityAt}` carry top-level commas
// that would otherwise be treated as anchor separators (Codex P1 on PR #96
// line 873; Plan-002 T1.3 regression).
function bracketDelta(ch) {
  if (ch === "(" || ch === "[" || ch === "{") return 1;
  if (ch === ")" || ch === "]" || ch === "}") return -1;
  return 0;
}

// The ONE character both cite splitters treat as a quoted-region toggle.
// Quoting the spec text a cite describes is the repo's preferred anchoring
// style, and a quoted sentence routinely carries commas — `"… must include
// session events, queue state, approvals …"`. Without quote tracking those
// commas read as anchor separators and shatter one cite into several
// unparseable fragments (the delimiters `bracketDelta` covers do not help:
// the quoted run sits at bracket depth 0).
//
// Straight ASCII `"` ONLY. A sweep of all 938 `**Spec coverage:**` /
// `**Verifies invariant:**` payloads in docs/plans/ found zero typographic
// quotes (U+201C / U+201D) and zero typographic apostrophes, so tracking
// them would be speculation about a shape the corpus does not hold; add
// them here (and a fixture) if one ever lands. The ASCII apostrophe is
// deliberately NOT a toggle — `don't` must stay inert rather than opening
// a region that swallows the rest of the payload.
//
// Failure posture on a MALFORMED quote — two distinct shapes, neither of
// which the splitters catch on their own:
//
//  1. ODD count. The toggle stays open through end-of-payload, so the tail
//     collapses into ONE buffered token. That token usually matches no
//     sub-anchor shape, but "usually" is not a gate: the anchors AHEAD of the
//     stray quote parse clean, so the payload can still report zero failures
//     while the claims behind it are never extracted. `parseCitePayload`'s
//     parity check is what actually fires.
//  2. EVEN count STRADDLING a bracket boundary. Both splitters toggle
//     `inQuote` and `continue` BEFORE consulting `bracketDelta`, so a `"`
//     opened inside `(...)` suppresses that group's `)`. Depth never returns
//     to 0, the next depth-0 separator is not honoured, and two cites merge
//     into one — the surviving token can parse as a perfectly valid anchor
//     while the second claim is silently discarded. Parity cannot see this
//     (the count is even); `quotedRunSwallowsBracket` is what fires.
//
// Both splitters remain single forward passes over a bounded string with no
// backtracking, so malformed input cannot hang.
const CITE_QUOTE_CHAR = '"';

/**
 * Detect a quoted run that swallows a bracket opened OUTSIDE it.
 *
 * Signature: walk the payload; on each quote-open start a local depth at 0 and
 * apply `bracketDelta` only while inside the run. A local depth that goes
 * NEGATIVE means the run consumed a closer for a group opened before the quote
 * — exactly the condition that leaves the splitters' depth counter stranded
 * above 0 and disables every separator behind it.
 *
 * Second signature — a run that ends NET NON-ZERO while carrying a separator.
 * The negative-dip test alone is defeated by an opener inside the run:
 * `line 10 (5" (window), line 99999 (30" grace)` runs +1/0/+1, never dips, and
 * the splitters emit ONE anchor for line 10 with zero failures — the line-99999
 * claim is silently dropped (Codex P2, PR #260 round 2). The splitters skip a
 * run's characters wholesale, which is sound only when the run's brackets net
 * to zero; a non-zero net means the depth they carried past the run described a
 * different nesting than the text does, and any separator inside the run was
 * discarded on the strength of that wrong depth.
 *
 * The separator conjunct is what keeps this from over-firing. A run that merely
 * OPENS a bracket (`line 10 ("foo (bar"), line 20`) also nets non-zero, but it
 * contains no separator, the splitters' depth outside it is unaffected, and the
 * payload still yields both anchors — so it stays unflagged. End-of-payload
 * depth remains the wrong test for the reason the parity count is: the inch-mark
 * case `line 10 (5" window), line 99999 (30" grace)` nets back to zero overall
 * and is caught by the dip test instead.
 *
 * Both signatures measured against every cite payload in `docs/plans/` before
 * being armed: zero matches, so neither adds a false positive to the standing
 * corpus.
 */
function quotedRunSwallowsBracket(payload) {
  let inQuote = false;
  let localDepth = 0;
  let runHasSeparator = false;
  for (const ch of payload) {
    if (ch === CITE_QUOTE_CHAR) {
      // Closing a run: the splitters skipped every character in it, which is
      // sound ONLY if the run's brackets net to zero. A run that nets non-zero
      // leaves the splitters' depth describing a different nesting than the
      // text does, and any separator that rode inside the run was dropped on
      // the strength of that wrong depth.
      if (inQuote && localDepth !== 0 && runHasSeparator) return true;
      if (!inQuote) {
        localDepth = 0;
        runHasSeparator = false;
      }
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote) continue;
    if (ch === "," || ch === ";" || ch === "+") runHasSeparator = true;
    localDepth += bracketDelta(ch);
    if (localDepth < 0) return true;
  }
  return false;
}

function splitOnSemicolon(payload) {
  const out = [];
  let depth = 0;
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i];
    if (ch === CITE_QUOTE_CHAR) {
      inQuote = !inQuote;
      buf += ch;
      continue;
    }
    if (inQuote) {
      buf += ch;
      continue;
    }
    const d = bracketDelta(ch);
    if (d !== 0) {
      depth += d;
      buf += ch;
    } else if (depth === 0 && ch === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    } else if (depth === 0 && ch === "," && TOP_LEVEL_NS_LOOKAHEAD.test(payload.slice(i))) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// Bracket-aware split on `,` and whitespace-bounded ` + ` at depth 0. Tracks
// `()`, `[]`, AND `{}` so TS-object-literal descriptors (`{deviceType, ...}`)
// don't break sub-anchor splitting. Applied after the namespace prefix is
// stripped so commas/pluses inside the remainder become sub-anchor
// separators (`AC1 (line 178), AC2 (line 179)` → two anchors; `line 87 +
// AC1` → two anchors).
function splitWithinNamespace(text) {
  const out = [];
  let depth = 0;
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // Quoted-region handling is symmetric with splitOnSemicolon — see
    // CITE_QUOTE_CHAR for the character choice and the failure posture.
    if (ch === CITE_QUOTE_CHAR) {
      inQuote = !inQuote;
      buf += ch;
      continue;
    }
    if (inQuote) {
      buf += ch;
      continue;
    }
    const d = bracketDelta(ch);
    if (d !== 0) {
      depth += d;
      buf += ch;
    } else if (depth === 0 && ch === ",") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    } else if (depth === 0 && ch === "+") {
      const prev = i > 0 ? text[i - 1] : "";
      const next = i + 1 < text.length ? text[i + 1] : "";
      if (/\s/.test(prev) || /\s/.test(next)) {
        if (buf.trim()) out.push(buf.trim());
        buf = "";
      } else {
        buf += ch;
      }
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// Gate 4 failures carry a severity. `error` blocks the gate (the seven
// post-mortem defect classes — subject mismatch, compound-range, namespace
// violation, Plan-local-ID-as-Spec-anchor, phantom section, file missing,
// out-of-range line). `warn` is informational and never blocks; it covers
// shapes the parser cannot recognize without falsely rejecting legitimate
// cite shapes in already-approved plans. The mandate is to catch the seven
// known defect classes, not to police every cite shape.
function makeFailure(kind, raw, message, remediation, severity = "error") {
  return { kind, raw, message, remediation, severity };
}

// Parse one Spec-NNN segment (after the top-level `;` split). Returns
// {anchors: [...], failures: [...]}. The segment may contain a §Section
// prefix, multiple sub-anchors (line / AC / line+AC / lines-range /
// lines-list), and trailing descriptors in parens. The four mechanism
// rejection classes from the runbook strengthened template fire here:
// compound-range with multi-subject descriptor, Plan-NNN:LLL inside
// descriptor, Plan-local-ID at first anchor position, phantom-section
// (verified later by verifyAnchorAgainstSpec).
function parseSpecSegment(segment) {
  const result = parseSpecSegmentInner(segment);
  // Stamp the segment's Spec number on every failure: sub-token failures
  // (compound-range-multi-subject and friends) carry only the sub-token as
  // `raw` (`lines 13-14 (…)`), so the demote gate's existence floor could not
  // see which Spec the segment named (Codex, PR #190 round 11).
  const specMatch = segment.match(/\bSpec-(\d{1,4})\b/);
  if (specMatch) {
    const spec = Number(specMatch[1]);
    return {
      anchors: result.anchors,
      failures: result.failures.map((f) => ({ ...f, spec: f.spec ?? spec })),
    };
  }
  return result;
}

function parseSpecSegmentInner(segment) {
  const nsMatch = segment.match(/^Spec-(\d+)\b\s*(.*)$/s);
  if (!nsMatch) {
    return {
      anchors: [],
      failures: [
        makeFailure(
          "spec-namespace-malformed",
          segment,
          `Spec namespace prefix malformed in '${segment}'.`,
          "Use the shape `Spec-NNN ...` where NNN is the 3-digit spec id.",
        ),
      ],
    };
  }
  const spec = Number(nsMatch[1]);
  const rest = nsMatch[2].trim();

  // Sweep the entire segment for the namespace-violation defect (Plan-NNN:LLL
  // inside any descriptor or position). Applies regardless of which sub-anchor
  // the violation sits within.
  const failures = [];
  if (PLAN_LINE_CITE_RE.test(segment)) {
    const match = segment.match(/\bPlan-\d+:\d+\b/);
    failures.push(
      makeFailure(
        "namespace-violation",
        segment,
        `'${match[0]}' is a Plan-NNN line cite inside a Spec-${spec} cite. Cross-plan line-anchors do not belong in Spec coverage.`,
        "Move cross-plan context into Files / Goal / Implementation Notes. Plan-NNN §Section (no colon-line-number) is the legitimate cross-plan parenthetical shape.",
      ),
    );
  }

  // Section-prefix detection. `§<Heading>` after the namespace and before the
  // first `line/lines/AC` keyword. The lazy boundary makes the section capture
  // stop at the keyword.
  //
  // The keyword alternation must spell BOTH acceptance-criterion shapes —
  // indexed (`AC4`) and by-line (`AC line 45`). Matching only `AC\d` let the
  // lazy capture run past a bare `AC` to the following `line`, which is
  // net-LOOSER twice over: the section captured a heading that does not exist
  // (`§Acceptance Criteria AC`), and the anchor degraded from `ac-line` — which
  // additionally proves in-section, is-a-checkbox-bullet, and subject-match —
  // down to a plain `line` anchor that proves only in-range and non-blank. A
  // section prefix must never weaken the anchor it prefixes.
  let section = null;
  let body = rest;
  const sectionMatch = body.match(/^§([^,;+]+?)(?=\s+(?:lines?|AC\d|AC\s+lines?\b)|\s*$|\s*\()/);
  if (sectionMatch) {
    section = sectionMatch[1].trim();
    body = body.slice(sectionMatch[0].length).trim();
  }

  // Section-adjacent parentheticals BEFORE a line/AC anchor — `§X (suffix)
  // line N`, or with gloss groups: `§X (suffix) (gloss) line N`. Consume
  // the ENTIRE run of leading paren groups into `sectionDescriptor` when —
  // and only when — the run is directly followed by a line/lines/AC
  // keyword, so the anchor reaches the anchor parser. Without this the
  // section-only branch below swallows the whole tail as descriptor text:
  // the anchor vanishes and an invalid line number rides a section-only
  // pass — round-3 P2 for the single-group form, round-5 P2 for the
  // multi-group form (Codex, PR #224). findSectionHeading reads the FIRST
  // group of the consumed run as the suffix claim (later groups stay
  // gloss, the marker-line convention), so a wrong suffix fails closed.
  // Balanced-group extraction keeps a nested suffix
  // (`(RFC 9111 (shared cache)) line N`) whole, and the `\b` keeps prose
  // descriptors (`(sfx) lineage of ...`) routing to section-only
  // unchanged.
  let sectionDescriptor = null;
  if (section) {
    let consumedEnd = 0;
    for (;;) {
      const nextGroup = leadingParenGroup(body.slice(consumedEnd));
      if (!nextGroup) break;
      consumedEnd += nextGroup.end;
      // Same both-AC-shapes rule as the section-prefix lookahead above. With
      // only `AC\d+` here, `§X (suffix) AC line 45` never consumed the paren
      // run, so `body` still began with `(` and the section-only branch below
      // swallowed the whole tail as descriptor text — the `line 45` claim
      // vanished entirely instead of being verified.
      if (/^\s+(?:lines?|AC\d+|AC\s+lines?)\b/.test(body.slice(consumedEnd))) {
        sectionDescriptor = body.slice(0, consumedEnd).trim();
        body = body.slice(consumedEnd).trim();
        break;
      }
    }
  }

  // Section-only form: `Spec-NNN §Section` (no lines / AC after).
  // Optionally followed by `(<descriptor>)`. Pass with a WARN — line anchor
  // is recommended but not required.
  if (section && (body === "" || /^\(/.test(body))) {
    return {
      anchors: [
        {
          type: "section-only",
          spec,
          section,
          descriptor: body,
          warn: "line anchor recommended for §Section-only cite",
          raw: segment,
        },
      ],
      failures,
    };
  }

  // First-anchor-position Plan-local-ID defect: bare token immediately after
  // `Spec-NNN ` (no `line`/`lines`/`AC`/`§` keyword) that matches a Plan-local
  // pattern (Cn / Pn / Pr-n / In). Discriminator vs pass case 10 (C5 (Spec-002 ...)):
  // here the Plan-local-ID sits in the namespace-prefix position; in pass case
  // 10 the segment STARTS with the Plan-local-ID and Spec lives inside a paren.
  const firstToken = body.match(/^([\w-]+)\b/);
  if (
    !section &&
    firstToken &&
    PLAN_LOCAL_ID_RE.test(firstToken[1]) &&
    !/^(AC\d|line|lines)/.test(body)
  ) {
    failures.push(
      makeFailure(
        "plan-local-id-as-spec-anchor",
        segment,
        `Plan-local row ID '${firstToken[1]}' cited as a Spec-${spec} anchor.`,
        `Reverse the framing: '${firstToken[1]} (Spec-${spec} line YY — descriptor)'. Plan-local row IDs (Cn / Pn / Pr-n / In) are not Spec anchors.`,
      ),
    );
    return { anchors: [], failures };
  }

  // Multi-line list (bare with optional shared trailing descriptor):
  // `lines N1, N2, N3` or `lines N1, N2, N3 (shared-descriptor)`. Detected
  // before the generic comma-split so we keep the `lines` keyword attached
  // to each emitted anchor and preserve the shared-descriptor semantics
  // for `RateLimitResponse canonical shape` and friends.
  const bareMultiLineMatch = body.match(/^lines\s+(\d+(?:\s*,\s*\d+)+)\s*(?:\((.*)\))?$/);
  if (bareMultiLineMatch) {
    const lineNums = bareMultiLineMatch[1].split(/\s*,\s*/).map((n) => Number(n));
    const descriptor = bareMultiLineMatch[2] ?? "";
    const subjects = nonPlanLocalSubjects(descriptor);
    const anchors = lineNums.map((line) => ({
      type: "line",
      spec,
      line,
      section,
      sectionDescriptor,
      subject: subjects.length === 1 ? subjects[0] : null,
      descriptor,
      raw: segment,
    }));
    return { anchors, failures };
  }

  // Multi-line list with per-line descriptors: `lines N1 (desc1), N2
  // (desc2), N3 (desc3)`. Required to accept Plan-002 T2.1 / T2.2 shapes
  // already on develop — `Spec-002 §Token Security Properties lines 110
  // (Entropy/CSPRNG), 111 (hash storage), 113 (Token payload structure)`
  // (Codex P1 on PR #96 line 873). Brace-aware splitWithinNamespace
  // handles TS-object-literal descriptors. Requires ≥2 entries so we
  // don't conflict with `lines N (subject)` typo cases for single lines.
  const linesKeywordMatch = body.match(/^lines\s+(.+)$/);
  if (linesKeywordMatch) {
    const tailTokens = splitWithinNamespace(linesKeywordMatch[1].trim());
    if (tailTokens.length >= 2) {
      const entries = [];
      let allParseable = true;
      for (const tok of tailTokens) {
        const m = tok.match(/^(\d+)(?:\s*\((.*)\))?\s*$/);
        if (!m) {
          allParseable = false;
          break;
        }
        entries.push({ line: Number(m[1]), descriptor: (m[2] ?? "").trim() });
      }
      if (allParseable) {
        const anchors = entries.map(({ line, descriptor }) => {
          const subjects = nonPlanLocalSubjects(descriptor);
          return {
            type: "line",
            spec,
            line,
            section,
            sectionDescriptor,
            subject: subjects[0] ?? null,
            descriptor,
            raw: segment,
          };
        });
        return { anchors, failures };
      }
    }
  }

  // General split on `,` and ` + ` for everything else (AC, line, line+AC).
  // Descriptor forms accepted: `(parens)` OR ` - dash-separated` (the latter
  // appears inside nested plan-local-id paren wrappers like `C5 (Spec-002
  // line 15 — ChannelList)` where the inner em-dash normalizes to `-` and
  // the wrapping paren is already consumed by the plan-local-id parser).
  //
  // Section context tracking: `currentSection` starts at the top-level
  // `section` (from `§<Heading>` prefix before the keyword) and updates
  // whenever a sub-token begins with its own `§<Section>` qualifier.
  // `inLinesList` admits bare-digit continuation tokens (`111 (hash
  // storage)`) immediately after a `§Section lines <N> (desc)` sub-token —
  // required for Plan-002 T2.2-shape cites (Codex P1 on PR #96 line 873).
  const subTokens = splitWithinNamespace(body);
  const anchors = [];
  let currentSection = section;
  // Suffix-claim scope: the prefix-consumed `sectionDescriptor` belongs to
  // the ORIGINAL `§section (suffix)` prefix run only. Any re-sectioning
  // sub-token starts a NEW heading claim — even one spelling the same
  // section name again (`§Usage (sfx) line 1, §Other line 2, §Usage line
  // 3`): the final bare `§Usage` must NOT silently inherit `(sfx)` when
  // suffixed siblings would make the bare cite ambiguous (Codex round-5,
  // PR #224). An explicit latch, not string equality on the name.
  let inOriginalSection = true;
  let inLinesList = false;
  for (const token of subTokens) {
    // `AC line N [(descriptor)]` — the acceptance-criterion-BY-LINE form
    // (`Spec-011 AC line 173`). Distinct from the ordinal `ACn (line MM)`
    // shape below: that one names the criterion by its INDEX within
    // §Acceptance Criteria and treats the line as a hint, this one names the
    // line the criterion sits on and leaves the ordinal implicit. Established
    // corpus vocabulary rather than a one-plan idiom — 16 marker payloads
    // across Plan-011, Plan-014, and Plan-025 — so the grammar learns the
    // shape instead of three plans being rewritten. It gets its OWN anchor
    // type and is deliberately NOT folded into the plain `line` anchor:
    // verifyAcLineAnchor additionally proves the cited line sits inside the
    // §Acceptance Criteria line bounds AND is a `- [ ]` checkbox bullet, so
    // admitting the shape STRENGTHENS verification (a plain line anchor would
    // accept `AC line 40` pointing at arbitrary prose). Must precede the
    // ordinal branch only for readability — `AC(\d+)` cannot match `AC line`.
    const acLineMatch = token.match(/^AC\s+line\s+(\d+)(?:\s*\((.+)\)|\s+-\s+(.+?))?\s*$/);
    if (acLineMatch) {
      const line = Number(acLineMatch[1]);
      const descriptor = (acLineMatch[2] ?? acLineMatch[3] ?? "").trim();
      const subjects = nonPlanLocalSubjects(descriptor);
      anchors.push({
        type: "ac-line",
        spec,
        line,
        section: currentSection,
        // Provenance of `section`, for the containment check in
        // verifyAcLineAnchor. An `AC line N` token can never carry its own `§`
        // (this regex is anchored at `^AC`), so the section is either the
        // payload's own `§` prefix — an authored claim about THIS criterion —
        // or a sibling sub-token's re-section leaking forward through the
        // sticky `currentSection`. Only the former may bound the line.
        sectionFromPrefix: inOriginalSection,
        sectionDescriptor: inOriginalSection ? sectionDescriptor : null,
        subject: subjects[0] ?? null,
        descriptor,
        raw: segment,
      });
      inLinesList = false;
      continue;
    }
    const acMatch = token.match(/^AC(\d+)(?:\s*\((.+)\)|\s+-\s+(.+?))?\s*$/);
    if (acMatch) {
      const ac = Number(acMatch[1]);
      const descriptor = (acMatch[2] ?? acMatch[3] ?? "").trim();
      const lineHint = descriptor.match(/\bline\s+(\d+)\b/);
      const subjects = nonPlanLocalSubjects(descriptor);
      anchors.push({
        type: "ac",
        spec,
        ac,
        lineHint: lineHint ? Number(lineHint[1]) : null,
        section: currentSection,
        // Same provenance rule as the `ac-line` branch above: `^AC\d+` cannot
        // carry its own `§`, so only a prefix-scoped section is this
        // criterion's own claim.
        sectionFromPrefix: inOriginalSection,
        // Prefix-consumed suffix rides only pre-re-section anchors — the
        // inOriginalSection latch at the loop head owns the rule.
        sectionDescriptor: inOriginalSection ? sectionDescriptor : null,
        subject: subjects.length === 1 ? subjects[0] : null,
        descriptor,
        warn: lineHint ? null : "line hint recommended (`AC-X (line NN)`)",
        raw: segment,
      });
      inLinesList = false;
      continue;
    }
    const lineMatch = token.match(/^line\s+(\d+)(?:\s*\((.+)\)|\s+-\s+(.+?))?\s*$/);
    if (lineMatch) {
      const line = Number(lineMatch[1]);
      const descriptor = (lineMatch[2] ?? lineMatch[3] ?? "").trim();
      const subjects = nonPlanLocalSubjects(descriptor);
      anchors.push({
        type: "line",
        spec,
        line,
        section: currentSection,
        sectionDescriptor: inOriginalSection ? sectionDescriptor : null,
        subject: subjects[0] ?? null,
        descriptor,
        raw: segment,
      });
      inLinesList = false;
      continue;
    }
    // Range sub-token: `lines N1-N2 [(descriptor)]`, optionally re-sectioned
    // (`§<Section> lines N1-N2 (...)`). Sole range parser: a standalone
    // range body arrives here as one sub-token (splitWithinNamespace only
    // breaks on depth-0 commas), and mid-list ranges split correctly. A
    // former whole-body `^lines N1-N2 (.*)$` handler both missed mid-list
    // ranges (they halted as unparseable while the fallback message
    // advertised the shape as accepted) and greedy-swallowed list tails —
    // `lines 39-40 (a), 41 (b)` parsed as one range with descriptor
    // `a), 41 (b`, silently dropping line 41's coverage. Must precede the
    // single-line re-section branch: that branch's ` - dash-descriptor`
    // alternative would claim a spaced range (`§A lines 12 - 15`) as
    // line 12 with descriptor "15". Carries the compound-range
    // multi-subject rejection so one-anchor-per-behavior holds for every
    // range position.
    const rangeTokenMatch = token.match(
      /^(?:§([^()]+?)\s+)?lines\s+(\d+)\s*-\s*(\d+)\s*(?:\((.*)\))?$/,
    );
    if (rangeTokenMatch) {
      if (rangeTokenMatch[1]) {
        currentSection = rangeTokenMatch[1].trim();
        inOriginalSection = false;
      }
      const start = Number(rangeTokenMatch[2]);
      const end = Number(rangeTokenMatch[3]);
      const descriptor = (rangeTokenMatch[4] ?? "").trim();
      const subjects = nonPlanLocalSubjects(descriptor);
      if (subjects.length >= 2) {
        failures.push(
          makeFailure(
            "compound-range-multi-subject",
            token,
            `Compound range 'lines ${start}-${end}' covers distinct subjects (${subjects.join(", ")}); one-anchor-per-behavior is required.`,
            `Write 'line ${start} (${subjects[0]}), line ${end} (${subjects[1]})' instead of a range. Each Spec line that names a distinct contract gets its own anchor.`,
          ),
        );
        inLinesList = false;
        continue;
      }
      anchors.push({
        type: "line-range",
        spec,
        start,
        end,
        section: currentSection,
        sectionDescriptor: inOriginalSection ? sectionDescriptor : null,
        subject: subjects[0] ?? null,
        descriptor,
        raw: segment,
      });
      inLinesList = true;
      continue;
    }
    // Re-section sub-anchor: `§<Section> line[s] YY[ (descriptor)]` inside a
    // comma-separated multi-section Spec cite (e.g., `Spec-002 §A line 12,
    // §B line 13` or `Spec-002 §A lines 12 (x), 13 (y), §B lines 20 (z)`).
    // Without this branch the second sub-token falls into the unparseable
    // fallback and the gate halts on shapes already in approved plans.
    const reSectionLineMatch = token.match(
      /^§([^()]+?)\s+(lines?)\s+(\d+)(?:\s*\((.+)\)|\s+-\s+(.+?))?\s*$/,
    );
    if (reSectionLineMatch) {
      currentSection = reSectionLineMatch[1].trim();
      inOriginalSection = false;
      const keyword = reSectionLineMatch[2];
      const line = Number(reSectionLineMatch[3]);
      const descriptor = (reSectionLineMatch[4] ?? reSectionLineMatch[5] ?? "").trim();
      const subjects = nonPlanLocalSubjects(descriptor);
      anchors.push({
        type: "line",
        spec,
        line,
        section: currentSection,
        sectionDescriptor: inOriginalSection ? sectionDescriptor : null,
        subject: subjects[0] ?? null,
        descriptor,
        raw: segment,
      });
      inLinesList = keyword === "lines";
      continue;
    }
    // Bare-digit list continuation: only valid immediately after a
    // `§Section lines <N>` sub-token (`inLinesList === true`). Emits a line
    // anchor under the current section context. Without this, T2.2-shape
    // `§A lines 109 (x), 111 (y), 112 (z)` halts on the trailing entries.
    const bareLineMatch = token.match(/^(\d+)(?:\s*\((.+)\)|\s+-\s+(.+?))?\s*$/);
    if (inLinesList && bareLineMatch) {
      const line = Number(bareLineMatch[1]);
      const descriptor = (bareLineMatch[2] ?? bareLineMatch[3] ?? "").trim();
      const subjects = nonPlanLocalSubjects(descriptor);
      anchors.push({
        type: "line",
        spec,
        line,
        section: currentSection,
        sectionDescriptor: inOriginalSection ? sectionDescriptor : null,
        subject: subjects[0] ?? null,
        descriptor,
        raw: segment,
      });
      continue;
    }
    failures.push(
      makeFailure(
        "unparseable-spec-subanchor",
        token,
        `Cannot parse '${token}' as a Spec-${spec} sub-anchor.`,
        "Accepted sub-shapes: `AC-N`, `AC-N (line MM)`, `AC line N`, `AC line N (subject)`, `line N`, `line N (subject)`, `line N - subject`, `lines N1, N2, N3`, `lines N1-N2 (single-subject)`, `§Section line N`, `§Section lines N1-N2 (single-subject)`.",
        "error",
      ),
    );
  }
  return { anchors, failures };
}

// ADR cite parser. Accepts `ADR-NNN`, `ADR-NNN §Section`, `ADR-NNN §Section
// item N`, `ADR-NNN §Section row N`, and any of these followed by a paren
// descriptor and/or trailing prose. Trailing prose is captured as-is; the
// recognized portion is the namespace + §Section + (optional) row/item.
function parseAdrSegment(segment) {
  // Capture: ADR-N, optional §Section (up to first `(` / EOL / row|item keyword),
  // optional row/item N, optional paren descriptor, ignore trailing prose.
  const m = segment.match(
    /^ADR-(\d+)\b(?:\s+§([^()]+?))?(?:\s+(?:row|item)\s+(\d+))?(?:\s*\(([^)]*)\))?(.*)$/,
  );
  if (!m) {
    return {
      anchors: [],
      failures: [
        makeFailure(
          "adr-unparseable",
          segment,
          `Cannot parse ADR cite '${segment}'.`,
          "Accepted: `ADR-NNN`, `ADR-NNN §Section`, `ADR-NNN §Section row N`, `ADR-NNN §Section item N`.",
          "warn",
        ),
      ],
    };
  }
  let section = (m[2] ?? "").trim() || null;
  // Strip the row|item phrase off the section capture if the section regex
  // absorbed it (e.g. `§Success Criteria row 2` may match the section as
  // `Success Criteria row 2` if the inner alternation didn't take effect).
  if (section) {
    const rowOrItem = section.match(/^(.+?)\s+(row|item)\s+(\d+)\s*$/);
    if (rowOrItem) section = rowOrItem[1].trim();
  }
  return {
    anchors: [
      {
        type: "adr-section",
        adr: Number(m[1]),
        section,
        row: m[3] ?? null,
        descriptor: m[4] ?? "",
        trailingProse: m[5]?.trim() ?? "",
        raw: segment,
      },
    ],
    failures: [],
  };
}

function parseArchDocSegment(segment) {
  // Accept trailing prose after the closing paren — legitimate descriptors
  // in approved plans include sentences after the anchor.
  const m = segment.match(/^([\w-]+\.md)(?:\s+§([^()]+?))?(?:\s*\(([^)]*)\))?(.*)$/);
  if (!m) {
    return {
      anchors: [],
      failures: [
        makeFailure(
          "arch-doc-unparseable",
          segment,
          `Cannot parse architecture-doc cite '${segment}'.`,
          "Accepted: `<file>.md`, `<file>.md §Section`, `<file>.md (descriptor)`.",
          "warn",
        ),
      ],
    };
  }
  const section = (m[2] ?? "").trim() || null;
  return {
    anchors: [
      {
        type: "arch-doc",
        file: m[1],
        section,
        descriptor: m[3] ?? "",
        trailingProse: m[4]?.trim() ?? "",
        warn: section ? null : "section anchor recommended",
        raw: segment,
      },
    ],
    failures: [],
  };
}

function parseCrossPlanDepsSegment(segment) {
  // Accept multi-row form: `cross-plan-deps §N row M + §K row L` (Plan-024
  // T-024-5-5 uses this for joint cross-plan-deps anchors). The base
  // namespace prefix `cross-plan-deps` appears once; subsequent §-clauses
  // join via `+` and may carry their own row.
  const m = segment.match(
    /^cross-plan-deps\s+§(\d+)(?:\s+row\s+(\d+))?((?:\s*\+\s*§\d+(?:\s+row\s+\d+)?)*)(?:\s*\(([^)]*)\))?(.*)$/,
  );
  if (!m) {
    return {
      anchors: [],
      failures: [
        makeFailure(
          "cross-plan-deps-unparseable",
          segment,
          `Cannot parse cross-plan-deps cite '${segment}'.`,
          "Accepted: `cross-plan-deps §N`, `cross-plan-deps §N row M`, `cross-plan-deps §N row M + §K row L`.",
          "warn",
        ),
      ],
    };
  }
  const anchors = [
    {
      type: "cross-plan-deps",
      section: m[1],
      row: m[2] ?? null,
      descriptor: m[4] ?? "",
      raw: segment,
    },
  ];
  // Parse any joined § / row clauses.
  for (const joinMatch of (m[3] ?? "").matchAll(/§(\d+)(?:\s+row\s+(\d+))?/g)) {
    anchors.push({
      type: "cross-plan-deps",
      section: joinMatch[1],
      row: joinMatch[2] ?? null,
      descriptor: m[4] ?? "",
      raw: segment,
    });
  }
  return { anchors, failures: [] };
}

function parsePlanLocalIdSegment(segment) {
  // The plan-local-ID prefix is the cite target; the rest is descriptor
  // (which may be parenthesised, dash-separated, or bare prose). We accept
  // any trailing form because legitimate plans use all three. Embedded
  // Spec/ADR cites inside the descriptor are still parsed recursively as
  // defense-in-depth against Plan-local-ID-wrap smuggling.
  const m = segment.match(/^([\w.-]+)(.*)$/s);
  if (!m || !PLAN_LOCAL_ID_RE.test(m[1])) {
    return {
      anchors: [],
      failures: [
        makeFailure(
          "plan-local-id-unparseable",
          segment,
          `Cannot parse plan-local-id cite '${segment}'.`,
          "Accepted plan-local-id shapes: Cn / Pn / Pr-n / In or I-NNN-N or I-NNN-N..M (structured invariant range).",
          "warn",
        ),
      ],
    };
  }
  const id = m[1];
  // Legitimate trailers are empty, whitespace-prefixed prose, or a paren
  // descriptor. A leading `,` / `;` / `+` means the segment-splitter did
  // not detect a boundary AND the trailer is not a descriptor — common
  // shape is `I-024-3, typo` (a malformed trailing cite) or `I-024-1,
  // I-024-2` when the splitter lookahead failed to recognize the
  // following plan-local-id prefix. Fail closed so the gate surfaces the
  // defect instead of swallowing the trailer as a descriptor (Codex P1
  // on PR #96 line 620).
  if (/^[,;+]/.test(m[2])) {
    return {
      anchors: [],
      failures: [
        makeFailure(
          "plan-local-id-malformed-trailer",
          segment,
          `Plan-local-id cite '${segment}' has malformed trailing text after id '${id}': '${m[2].trim()}'. Trailing text must be empty, a parenthetical descriptor, or whitespace-prefixed prose.`,
          "Separate multiple plan-local-ids with `, ` ensuring each is a valid id (Cn / Pn / Pr-n / In or I-NNN-N), or wrap a descriptor in parentheses.",
        ),
      ],
    };
  }
  const rest = m[2].trim();
  const parenMatch = rest.match(/^\(([^)]*)\)/);
  const descriptor = parenMatch ? parenMatch[1] : rest;
  const anchors = [{ type: "plan-local-id", id, descriptor, raw: segment }];
  const failures = [];
  if (descriptor && /\bSpec-\d+\b|\bADR-\d+\b/.test(descriptor)) {
    const nested = parseCitePayload(descriptor);
    anchors.push(...nested.anchors);
    failures.push(...nested.failures);
  }
  return { anchors, failures };
}

function parseSegment(segment) {
  const trimmed = segment.trim();
  if (/^Spec-\d+\b/.test(trimmed)) return parseSpecSegment(trimmed);
  if (/^ADR-\d+\b/.test(trimmed)) return parseAdrSegment(trimmed);
  if (/^[\w-]+\.md\b/.test(trimmed)) return parseArchDocSegment(trimmed);
  if (/^cross-plan-deps\b/.test(trimmed)) return parseCrossPlanDepsSegment(trimmed);
  if (/^none\b/i.test(trimmed)) {
    return {
      anchors: [{ type: "none-literal", raw: trimmed }],
      failures: [],
    };
  }
  // Plan-local-ID at top-level position (legitimate when not inside a
  // Spec-NNN prefix).
  if (/^(?:C|P|Pr|I)-?\d+\b/.test(trimmed)) {
    return parsePlanLocalIdSegment(trimmed);
  }
  return {
    anchors: [],
    failures: [
      makeFailure(
        "unparseable-cite",
        trimmed,
        `Token '${trimmed}' matches no namespace pattern after dash normalization.`,
        "Cite must start with `Spec-NNN`, `ADR-NNN`, `<doc>.md`, `cross-plan-deps`, `none`, or a Plan-local ID (Cn/Pn/Pr-n/I).",
        "error",
      ),
    ],
  };
}

// Parse one **Spec coverage:** or **Verifies invariant:** payload (the
// value after the bold key). Returns {anchors[], failures[]} aggregated
// across all top-level segments.
//
// Defense-in-depth: after per-segment parsing, scan the normalized payload
// for the compound-range defect class (`lines NN-MM (X/Y …)` where X and Y
// are distinct identifier-tokens). This catches the T3.3-shape (post-mortem
// defect class 2) even when the surrounding shape (multi-§Section, prose
// continuation, mixed-namespace) means parseSpecSegment didn't reach the
// range branch. Falsely accepting a compound-range defect is the load-
// bearing failure the en-dash normalization + this scan exist to prevent.
export function parseCitePayload(rawPayload) {
  const normalized = normalizeCitePayload(rawPayload);
  const anchors = [];
  const failures = [];
  // Unbalanced-quote guard. Both splitters toggle on CITE_QUOTE_CHAR, so a
  // stray `"` leaves the toggle open through end-of-payload: every separator
  // behind it is absorbed into one trailing token, and the claims behind it
  // are never extracted as anchors — so they are never verified. That is a
  // SILENT TRUNCATION rather than a parse error: the anchors ahead of the
  // quote parse clean and the payload reports nothing, which is precisely the
  // false-clean shape this gate exists to prevent. Without this check
  // `Spec-015 line 47 — "oops, Spec-011 line 99999` yields ONE anchor and zero
  // failures, while the same text unquoted yields two anchors and gates on the
  // bad line. Parity is the exact test for THAT shape — `"` is a single
  // toggling delimiter with no escape form, so an odd count is unbalanced by
  // construction.
  //
  // Parity alone is NOT sufficient. An EVEN number of quotes straddling a
  // bracket boundary produces the same silent truncation without ever
  // unbalancing the count: `Spec-002 line 10 (5" window), line 99999 (30"
  // grace)` yields ONE anchor (`line 10`) and zero failures, because the
  // quoted run swallowed the first group's `)` and stranded the splitters'
  // depth above 0 — the `line 99999` claim is discarded unverified, while the
  // same text unquoted yields two anchors and gates on the bad line. The two
  // checks are complementary, not redundant: parity sees the odd no-bracket
  // case that carries no bracket to straddle, and the depth signature sees the
  // even case parity is blind to. Both emit the same kind — one hole, two
  // signatures.
  //
  // The kind is deliberately absent from G4_GRAMMAR_DEMOTE_KINDS,
  // INLINE_SHAPE_PARSE_KINDS, and LEGACY_INLINE_EXEMPT_KINDS (all three are
  // allowlists), so it stays a hard error on every path and for every size
  // class. Anchors ahead of the malformed quote still parse and verify — the
  // finding gates the payload without discarding what was legible.
  const quoteCount = normalized.split(CITE_QUOTE_CHAR).length - 1;
  if (quoteCount % 2 !== 0) {
    failures.push(
      makeFailure(
        "unbalanced-cite-quote",
        normalized,
        `Cite payload holds an unbalanced ${CITE_QUOTE_CHAR} (${quoteCount} occurrence(s)); separators after the stray quote are swallowed, so any claim behind it is silently dropped instead of verified.`,
        `Close the quoted run, or delete the stray ${CITE_QUOTE_CHAR}. Quoting is only needed to protect commas or semicolons INSIDE a quoted spec sentence.`,
      ),
    );
  } else if (quotedRunSwallowsBracket(normalized)) {
    failures.push(
      makeFailure(
        "unbalanced-cite-quote",
        normalized,
        `Cite payload opens a ${CITE_QUOTE_CHAR} inside a bracketed group and closes it outside — the quoted run swallows that group's closing bracket, so every separator behind it is ignored and the following claim is merged away instead of verified.`,
        `Move the ${CITE_QUOTE_CHAR}…${CITE_QUOTE_CHAR} run so it opens and closes within one bracketed group, or drop the quotes. A quote used as an inch/second mark (5${CITE_QUOTE_CHAR}) must be spelled out instead — quoting is only needed to protect commas or semicolons INSIDE a quoted spec sentence.`,
      ),
    );
  }
  const segments = splitOnSemicolon(normalized);
  for (const seg of segments) {
    const { anchors: a, failures: f } = parseSegment(seg);
    anchors.push(...a);
    failures.push(...f);
  }
  // Payload-level compound-range defense-in-depth scan.
  const compoundRangeRe = /\blines\s+(\d+)\s*-\s*(\d+)\s*\(([^)]+)\)/g;
  for (const m of normalized.matchAll(compoundRangeRe)) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    const descriptor = m[3];
    const subjects = nonPlanLocalSubjects(descriptor);
    if (subjects.length >= 2) {
      // Don't re-emit if the per-segment parser already caught this one.
      const dup = failures.some(
        (f) => f.kind === "compound-range-multi-subject" && f.raw.includes(`lines ${start}-${end}`),
      );
      if (!dup) {
        failures.push(
          makeFailure(
            "compound-range-multi-subject",
            m[0],
            `Compound range 'lines ${start}-${end}' covers distinct subjects (${subjects.join(", ")}); one-anchor-per-behavior is required.`,
            `Write 'line ${start} (${subjects[0]}), line ${end} (${subjects[1]})' instead of a range. Each Spec line that names a distinct contract gets its own anchor.`,
          ),
        );
      }
    }
  }
  return { anchors, failures };
}

// Extract every cite payload (Spec coverage / Verifies invariant) from a
// phase section and return the aggregated parse result. Each finding
// carries the field name and the originating task-row id (if discoverable
// from the surrounding bullet structure) for actionable failure messages.
//
// Payload termination: the value after a Spec coverage / Verifies invariant
// marker extends until the FIRST of:
//   (a) the next `**Word:**` bold-labeled marker (`**Spec coverage:**`,
//       `**Verifies invariant:**`, `**Note:**`, `**Files:**`, `**Wires:**`,
//       etc. — Plan-024 task bullets pack multiple labeled clauses on one
//       line),
//   (b) the next newline (canonical per-bullet shape from
//       docs/plans/000-plan-template.md).
// Trailing punctuation (`.`, `,`) is stripped from the payload after
// termination so the per-namespace parser regexes can anchor cleanly.
export function extractCiteAnchors(phaseSection) {
  const anchors = [];
  const failures = [];
  const targetMarkerRe = /\*\*(Spec coverage|Verifies invariant):\*\*/g;
  const anyMarkerRe = /\*\*[A-Z][\w ]*:\*\*/g;
  // Masked, and length-preserving so every offset below still indexes the raw
  // source. Extracting an example's cites would VERIFY them — the example
  // resolves against real spec files and reports clean, which is how a plan
  // with no real audit output passed as screened (Codex P2, #260 round 2 for
  // the fenced form; #262 round 5 for the inline-span form).
  const scanned = maskNonContentLines(phaseSection);
  // TWO VIEWS, one offset space. Inline-code masking decides WHICH MARKERS ARE
  // REAL; it must not touch the bytes a payload is sliced from.
  //
  // Cite payloads legitimately contain inline code — 196 live anchors carry a
  // backticked identifier inside their `(descriptor)` tail. Slicing those from
  // span-masked text blanks the identifier, and `raw` is not merely
  // diagnostic: `demotionKeepsExistenceFloor` greps it for `Spec-NNN` to decide
  // whether a demotion keeps the spec-existence floor, and the paren-stripped
  // section fallback compares the descriptor's cited suffix. A blanked
  // `Spec-NNN` inside backticks would silently drop out of that floor — a
  // fails-open regression introduced by the very screen meant to close one.
  //
  // Both maskers are length-preserving, so `markerView` indexes identically to
  // `scanned`: marker POSITIONS come from the masked view, payload BYTES from
  // the unmasked one. Terminators use the masked view too — a backticked
  // `**Files:**` inside a payload is illustration and must not end it.
  const markerView = maskInlineCodeSpans(scanned);
  const targetMarkers = [...markerView.matchAll(targetMarkerRe)];
  const anyMarkers = [...markerView.matchAll(anyMarkerRe)];
  for (const marker of targetMarkers) {
    const field = marker[1];
    const startIdx = marker.index + marker[0].length;
    const nextAnyMarker = anyMarkers.find((m) => m.index > marker.index);
    const nextMarkerIdx = nextAnyMarker ? nextAnyMarker.index : scanned.length;
    const nextNewlineIdx = scanned.indexOf("\n", startIdx);
    const endIdx = Math.min(nextMarkerIdx, nextNewlineIdx === -1 ? scanned.length : nextNewlineIdx);
    // Payload bytes from `scanned` — backticked identifiers intact (see the
    // two-views note above).
    let payload = scanned.slice(startIdx, endIdx).trim();
    // Strip trailing sentence-end punctuation that follows the closing paren
    // of the last cite descriptor (`(...).` → `(...)`).
    payload = payload.replace(/[.,;:]+\s*$/, "");
    // Attribution scans the MASKED view: a task id inside a code span is a
    // mention, not a header.
    const prefix = markerView.slice(0, marker.index);
    // Attribution = the NEAREST PRECEDING task header, in any spelling — hence
    // the shared `taskHeaderMatches` recognizer rather than a private copy.
    // Both halves of this were wrong before, and both mis-LABEL findings rather
    // than mis-gate them (`taskId` is diagnostic; it never feeds a pass/fail
    // decision), which is exactly why it went unnoticed — the gate's verdict
    // stayed correct while its finger pointed at the wrong row:
    //
    //   1. The private bullet form required `**` to close immediately after the
    //      id (`- **T-025d-14-1** (Files: …)`). The corpus-dominant spelling
    //      closes it after the TITLE (`- **T1.2 — Seven wire pairs.**`). 241
    //      headers across 12 plans went unrecognized — 220 in-phase — so every
    //      marker under one inherited the last id that DID match.
    //   2. `??` preferred the heading form whenever any `#####` header appeared
    //      anywhere in the prefix, even with a bullet header closer to the
    //      marker. Nearest-preceding means latest by INDEX, not by spelling.
    const taskMatch = taskHeaderMatches(prefix).reduce(
      (latest, m) => (latest === null || m.index > latest.index ? m : latest),
      null,
    );
    const taskId = taskMatch ? taskMatch[1] : null;
    const lineNo = prefix.split("\n").length;
    // An empty payload is a FINDING, not a skip. The bare `continue` that stood
    // here produced the gate's purest false clean: the marker floor counts the
    // marker (the field is present and correctly spelled), the extractor
    // silently drops it, and the unit returns
    // `{ok: true, hasCiteMarkers: true, findings: []}` — the report credits a
    // cite as screened when nothing was verified, which is strictly worse than
    // the missing-marker case the floor already halts on (Codex P2, PR #262
    // round 5).
    //
    // Deliberately NOT in G4_GRAMMAR_DEMOTE_KINDS: that set is fail-closed by
    // polarity, so an unlisted kind stays a hard error for every size class. A
    // marker claiming coverage while naming nothing is existence-shaped, not a
    // grammar slip, and demoting it for S/M would reopen this hole for exactly
    // the classes with the least reviewer coverage.
    if (!payload) {
      failures.push({
        kind: "empty-cite-payload",
        raw: marker[0],
        field,
        taskId,
        lineNo,
        message: `\`${marker[0]}\` names no cite — the marker is present but its payload is empty.`,
        remediation:
          "Give the marker a cite payload, or delete the marker. An empty field is indistinguishable from an unaudited one.",
        severity: "error",
      });
      continue;
    }
    const { anchors: a, failures: f } = parseCitePayload(payload);
    for (const anchor of a) {
      anchors.push({ ...anchor, field, taskId, lineNo });
    }
    for (const failure of f) {
      failures.push({ ...failure, field, taskId, lineNo });
    }
  }
  return { anchors, failures };
}

// Verify one anchor against the spec file it cites. For `type: line`,
// confirm the cited line is non-blank, in-range, and (if a subject is
// present) contains identifier-tokens matching the subject. For `type: ac`,
// confirm the N-th `- [ ]` / `- [x]` bullet inside the §Acceptance Criteria
// section exists. For `type: line-range`, confirm the range is in bounds.
// For `type: section-only`, confirm the named section heading exists.
// Returns {valid, reason, evidence}.
export function verifyAnchorAgainstSpec(
  anchor,
  { specsDir, adrsDir, archDocsDir, crossPlanDepsFile },
) {
  // `none` and `plan-local-id` have no external document to verify;
  // they pass trivially. The three file-bearing namespaces (ADR /
  // arch-doc / cross-plan-deps) get file-existence checks below so
  // typos like `ADR-999 §Whatever` or `missing-doc.md` don't silently
  // pass Gate 4. Section-internal verification within those docs is
  // out-of-scope (different heading conventions per namespace).
  if (anchor.type === "none-literal" || anchor.type === "plan-local-id") {
    return { valid: true, reason: "no-external-doc-to-verify", evidence: anchor.raw };
  }
  if (anchor.type === "adr-section") {
    if (!adrsDir) {
      return { valid: true, reason: "adrs-dir-unconfigured", evidence: anchor.raw };
    }
    const adrMatches = findPaddedFiles(adrsDir, anchor.adr);
    if (adrMatches.length === 0) {
      return {
        valid: false,
        reason: "adr-file-not-found",
        evidence: `No file matched ${adrsDir}/${String(anchor.adr).padStart(3, "0")}-*.md`,
      };
    }
    if (adrMatches.length > 1) {
      return {
        valid: false,
        reason: "adr-file-ambiguous",
        evidence: `Multiple files matched ${adrsDir}/${String(anchor.adr).padStart(3, "0")}-*.md: ${adrMatches.map((p) => basename(p)).join(", ")}. Rename or remove the duplicate so the ADR number resolves uniquely.`,
      };
    }
    return { valid: true, reason: "adr-file-exists", evidence: adrMatches[0] };
  }
  if (anchor.type === "arch-doc") {
    if (!archDocsDir) {
      return { valid: true, reason: "arch-docs-dir-unconfigured", evidence: anchor.raw };
    }
    const archMatches = findArchDocFiles(archDocsDir, anchor.file);
    if (archMatches.length === 0) {
      return {
        valid: false,
        reason: "arch-doc-not-found",
        evidence: `No file named ${anchor.file} found under ${archDocsDir} (recursive search).`,
      };
    }
    if (archMatches.length > 1) {
      return {
        valid: false,
        reason: "arch-doc-ambiguous",
        evidence: `Multiple files named ${anchor.file} found under ${archDocsDir}: ${archMatches.join(", ")}. Disambiguate by directory path or remove the duplicate.`,
      };
    }
    return { valid: true, reason: "arch-doc-exists", evidence: archMatches[0] };
  }
  if (anchor.type === "cross-plan-deps") {
    if (!crossPlanDepsFile) {
      return { valid: true, reason: "cross-plan-deps-file-unconfigured", evidence: anchor.raw };
    }
    if (!existsSync(crossPlanDepsFile)) {
      return {
        valid: false,
        reason: "cross-plan-deps-file-not-found",
        evidence: `cross-plan-deps file does not exist at ${crossPlanDepsFile}.`,
      };
    }
    return { valid: true, reason: "cross-plan-deps-file-exists", evidence: crossPlanDepsFile };
  }
  const specMatches = findPaddedFiles(specsDir, anchor.spec);
  if (specMatches.length === 0) {
    return {
      valid: false,
      reason: "spec-file-not-found",
      evidence: `No file matched ${specsDir}/${String(anchor.spec).padStart(3, "0")}-*.md`,
    };
  }
  if (specMatches.length > 1) {
    return {
      valid: false,
      reason: "spec-file-ambiguous",
      evidence: `Multiple files matched ${specsDir}/${String(anchor.spec).padStart(3, "0")}-*.md: ${specMatches.map((p) => basename(p)).join(", ")}. Rename or remove the duplicate so the spec number resolves uniquely.`,
    };
  }
  const specFile = specMatches[0];
  let source;
  try {
    source = readFileSync(specFile, "utf8");
  } catch (e) {
    return {
      valid: false,
      reason: "spec-file-unreadable",
      evidence: `${specFile}: ${e.message}`,
    };
  }
  const specLines = source.split("\n");
  if (anchor.type === "line") {
    return verifyLineAnchor(anchor, specLines);
  }
  if (anchor.type === "line-range") {
    return verifyLineRangeAnchor(anchor, specLines);
  }
  if (anchor.type === "ac") {
    return verifyAcAnchor(anchor, source, specLines);
  }
  if (anchor.type === "ac-line") {
    return verifyAcLineAnchor(anchor, source, specLines);
  }
  if (anchor.type === "section-only") {
    return verifySectionAnchor(anchor, specLines);
  }
  return { valid: true, reason: "no-spec-type", evidence: anchor.raw };
}

function normalizeTokenForMatch(tok) {
  return tok.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// `Spec-NNN §Section line N` / `§Section lines N1, N2` / `§Section AC-X` —
// the parser attaches `.section` to line / line-range / AC anchors so the
// verifier can reject phantom-section names alongside the line / AC check.
// Without this, `Spec-002 §NotARealSection line 13` accepts as long as line
// 13 exists (Codex P2 on PR #96 line 1301).
// Suffix comparison normalizer. Unlike normalizeTokenForMatch it PRESERVES
// punctuation — `(v1.0)` and `(v10)` are distinct versions and must not
// collapse (Codex round-3 P2, PR #224) — and strips only case, whitespace,
// and markdown code/emphasis markers, so a cite may spell a backticked
// heading suffix (`### Contract Layer (\`packages/contracts/\`)`) without
// the backticks. Underscores strip ONLY at delimiter positions (a run not
// flanked by a letter/digit on its outer side — CommonMark forbids
// intra-word `_` emphasis), so `(_V1_)` is citable as `(V1)` while the
// semantic interior underscore of `(usage_telemetry)` stays load-bearing
// and distinct (Codex round-6, PR #224). Underscores strip BEFORE
// whitespace: removing spaces first could join tokens and disguise
// delimiter runs as phantom intra-word ones.
function normalizeSuffixForMatch(tok) {
  return tok
    .toLowerCase()
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .replace(/[\s`*]/g, "");
}

// First parenthetical group of a descriptor tail, balanced: against
// `(RFC 9111 (shared cache)) (gloss)` it yields the full first group where
// a `[^)]*` regex would truncate at the inner close (Codex round-4,
// PR #224). Returns { group, end } — the inner text and the index just
// past the closing paren in the ORIGINAL string — or null when the text
// does not lead with a complete balanced group.
function leadingParenGroup(text) {
  const start = text.length - text.trimStart().length;
  if (text[start] !== "(") return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return { group: text.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

// Trailing parenthetical suffix of a heading, balanced: walks back from
// the end so a suffix whose content itself nests parens — the Plan-008
// CP-008-8 heading's markdown links, a `(RFC 9111 (shared cache))` — is
// ONE suffix instead of a regex truncation (Codex round-4, PR #224).
// Returns { suffix, start } — the inner text and the opening paren's
// index — or null when the heading does not end with a balanced group.
function trailingParenSuffix(headingText) {
  const text = headingText.trimEnd();
  if (!text.endsWith(")")) return null;
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] === ")") depth += 1;
    else if (text[i] === "(") {
      depth -= 1;
      if (depth === 0) return { suffix: text.slice(i + 1, text.length - 1), start: i };
    }
  }
  return null;
}

export function findSectionHeading(sectionName, specLines, citedDescriptorTail = null) {
  // Exact-after-normalize match. The earlier `.includes()` form let
  // `§Token line 39` pass when the actual heading was `Token Security
  // Properties` because the substring check accepted any heading-prefix
  // (Codex P2 on PR #96 line 1435). Anchored equality binds the cite to
  // one heading specifically.
  //
  // Paren-stripped fallback: the cite grammar's section capture stops at
  // ` (` (a trailing `(<descriptor>)` is descriptor, not section name), so
  // a cite to a parenthetical-suffixed heading — `### Usage Telemetry
  // (usage_telemetry)`, the Spec-006 category-heading house style — parses
  // as `Usage Telemetry` and anchored equality against the full heading
  // can never match. The fallback matches on the heading with its TRAILING
  // parenthetical suffix stripped — exactly the one token the capture
  // loses. A mid-heading parenthetical stays load-bearing, so `§Postgres
  // Deletion` cannot synthesize a match against a real `Postgres (Control
  // Plane) Deletion` heading (Codex P2 on PR #224).
  //
  // Resolution rules (fail-closed; Codex rounds 2-3 and 6, PR #224):
  // - The cited descriptor's FIRST paren group, when present, is read as a
  //   suffix claim. It binds the same-base heading whose real trailing
  //   suffix agrees (punctuation-preserving compare — `(v1.0)` never
  //   satisfies `(v10)`), so `§Required Behavior (policy)` binds the
  //   suffixed subsection even when a bare `## Required Behavior` sibling
  //   exists (the one real governance pair, Spec-020), and `§Interface
  //   (V1)` can never repair onto `(V2)`.
  // - A descriptor that LEADS with `(` but never balances (`§Usage
  //   (wrong`) is a malformed suffix claim, not a gloss → reject.
  // - With NO suffixed same-base sibling in the doc, a descriptor is free-
  //   text gloss and the bare exact hit stands (the pervasive
  //   `§Rate Limiting (20/session/hr …)` idiom).
  // - With suffixed same-base siblings present, a descriptor matching none
  //   of them is undecidable (gloss vs wrong suffix) → reject.
  // - A bare cite (no descriptor): a GENUINELY unsuffixed exact hit wins;
  //   else the stripped-match candidates must name exactly ONE distinct
  //   heading (punctuation-preserving distinctness, so `(v1.0)` / `(v10)`
  //   siblings stay ambiguous — and so do `(+)` / `(-)`, whose full texts
  //   both normalize to the bare target) or the cite is rejected.
  // The scan reads only structural content (shared structuralScanConsumes
  // state with findSectionBoundary): a fenced example `## Phantom (v1)`,
  // a ``` literal inside 4-space-indented code, and a heading inside a
  // multi-line HTML comment, raw HTML block, or multi-line code span are
  // none of them citable headings — and a 7-plus-hash pseudo-heading is
  // prose (CommonMark caps ATX at six). Suffix extraction is
  // balanced-paren on both sides, so a nested trailing suffix
  // (`(RFC 9111 (shared cache))`, the Plan-008 CP-008-8 link shape)
  // strips and compares as one token.
  // Widens-only vs the pre-fallback matcher: exact matches still win, and
  // the PR #96 heading-prefix laxity does not return.
  const target = normalizeTokenForMatch(sectionName);
  const citedGroup =
    typeof citedDescriptorTail === "string" ? leadingParenGroup(citedDescriptorTail) : null;
  const citedSuffix = citedGroup ? normalizeSuffixForMatch(citedGroup.group) : null;
  // A descriptor tail that LEADS with `(` but never balances (`§Usage
  // (wrong`) is a malformed suffix claim, not a bare cite — silently
  // dropping the claim would let the fallback bind a heading the cite may
  // contradict (Codex round-6, PR #224). A tail with no leading paren
  // stays on the free-text gloss path.
  if (
    typeof citedDescriptorTail === "string" &&
    citedDescriptorTail.trimStart().startsWith("(") &&
    citedGroup === null
  ) {
    return { found: false };
  }
  let exactHit = null;
  const suffixCandidates = [];
  const scanState = createStructuralScanState();
  for (let lineIndex = 0; lineIndex < specLines.length; lineIndex += 1) {
    const line = specLines[lineIndex];
    // ATX headings cap at SIX hashes (CommonMark 4.2): `####### Phantom`
    // is prose and must not seed the suffix fallback (Codex round-6,
    // PR #224).
    if (structuralScanConsumes(scanState, specLines, lineIndex) || !/^#{1,6}\s+/.test(line)) {
      continue;
    }
    // Optional ATX closing hashes (`## Interface (V1) ##`) would hide the
    // trailing suffix from the paren walk; CommonMark requires whitespace
    // before the closing run, so a heading ending in `C#` keeps its hash
    // (Codex round-5, PR #224).
    const headingText = line.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "");
    // A heading carrying a trailing paren suffix is never a GENUINE exact
    // hit: a punctuation-only suffix (`## Interface (+)`) normalizes away
    // in the exact comparison, so full-text "exact" matches let a bare
    // cite bypass the sibling-ambiguity check (`(+)` vs `(-)` both
    // erase to the target) and let the gloss pass ride an erased suffix.
    // Suffixed headings register ONLY as suffix candidates; the exact
    // slot is reserved for headings with no trailing suffix (Codex
    // rounds 5-6, PR #224).
    const trailingSuffix = trailingParenSuffix(headingText);
    if (
      trailingSuffix === null &&
      exactHit === null &&
      normalizeTokenForMatch(headingText) === target
    ) {
      exactHit = { found: true, headingLine: line.trim() };
    }
    if (trailingSuffix) {
      const strippedHeading = headingText.slice(0, trailingSuffix.start).trimEnd();
      if (normalizeTokenForMatch(strippedHeading) === target) {
        const headingSuffix = normalizeSuffixForMatch(trailingSuffix.suffix);
        suffixCandidates.push({
          headingLine: line.trim(),
          suffix: headingSuffix,
          distinctKey: `${normalizeTokenForMatch(strippedHeading)}|${headingSuffix}`,
        });
      }
    }
  }
  if (citedSuffix !== null) {
    const agreeing = suffixCandidates.filter((candidate) => candidate.suffix === citedSuffix);
    const distinctAgreeing = new Set(agreeing.map((candidate) => candidate.distinctKey));
    if (distinctAgreeing.size === 1) {
      return { found: true, headingLine: agreeing[0].headingLine };
    }
    if (suffixCandidates.length === 0 && exactHit) {
      return exactHit; // pure gloss — no suffixed sibling to contradict
    }
    return { found: false };
  }
  if (exactHit) return exactHit;
  const distinctCandidates = new Set(suffixCandidates.map((candidate) => candidate.distinctKey));
  if (distinctCandidates.size === 1) {
    return { found: true, headingLine: suffixCandidates[0].headingLine };
  }
  return { found: false };
}

function sectionNotFoundFailure(sectionName) {
  return {
    valid: false,
    reason: "section-not-found",
    evidence: `Section heading '${sectionName}' not present in spec.`,
  };
}

// Line spans of every heading whose text equals `headingText`, under NESTED
// containment: a heading at level L runs until the next heading of level <= L,
// so a `##` section contains its `###` children. Returned as 1-based inclusive
// `{start, end}` pairs.
//
// Why a separate scan instead of a position from findSectionHeading: that
// function returns the matched heading's TEXT, resolves to the FIRST match, and
// carries a six-round contract (suffix candidates, gloss disambiguation, the
// paren-stripped fallback) that must not be perturbed to add a position field.
// Matching on the already-resolved heading text keeps this additive, and
// collecting EVERY same-named span keeps a duplicated heading from producing a
// false containment failure — the resolver picks one, but a cite is legitimate
// if its line sits under any of them.
//
// Shares createStructuralScanState/structuralScanConsumes with the other two
// heading scanners (the one-transition-function discipline), so a fenced
// `## Phantom`, a heading inside an HTML comment, and a 7-hash pseudo-heading
// are all non-headings here exactly as they are there. Getting that wrong would
// truncate a section early and manufacture violations.
function sectionSpansForHeadingText(specLines, headingText) {
  const headings = [];
  const scanState = createStructuralScanState();
  for (let lineIndex = 0; lineIndex < specLines.length; lineIndex += 1) {
    const line = specLines[lineIndex];
    if (structuralScanConsumes(scanState, specLines, lineIndex) || !/^#{1,6}\s+/.test(line)) {
      continue;
    }
    headings.push({
      lineNumber: lineIndex + 1,
      level: /^(#{1,6})/.exec(line)[1].length,
      text: line.trim(),
    });
  }
  const spans = [];
  for (let h = 0; h < headings.length; h += 1) {
    if (headings[h].text !== headingText) continue;
    let end = specLines.length;
    for (let k = h + 1; k < headings.length; k += 1) {
      if (headings[k].level <= headings[h].level) {
        end = headings[k].lineNumber - 1;
        break;
      }
    }
    spans.push({ start: headings[h].lineNumber, end });
  }
  return spans;
}

// A cite that names BOTH a section and a line asserts the line sits under that
// heading. Verifying only that the heading EXISTS lets the two halves drift
// apart silently: Plan-015 T15.1 cited `§Two-Phase Receipt Commit lines 79-110`
// when that subsection starts at line 81, and the armed gate passed it because
// the heading resolved. The section name is the reader's index into the spec —
// a wrong one sends them to the wrong place while every mechanical check stays
// green. Fail-closed: an unresolvable span set (heading text matched nothing on
// re-scan) is treated as NOT contained rather than waved through.
function sectionContainmentFailure(anchor, specLines, sectionHeadingText, lo, hi) {
  const spans = sectionSpansForHeadingText(specLines, sectionHeadingText);
  if (spans.some((span) => lo >= span.start && hi <= span.end)) return null;
  const where = spans.length
    ? spans.map((span) => `${span.start}-${span.end}`).join(", ")
    : "(heading text did not re-resolve)";
  const cited = lo === hi ? `line ${lo}` : `lines ${lo}-${hi}`;
  return {
    valid: false,
    reason: lo === hi ? "line-outside-section" : "line-range-outside-section",
    evidence: `Cited ${cited} does not sit inside '${anchor.section}' (section spans ${where}). Name the section that actually contains the line, or cite the line without a section.`,
  };
}

function verifyLineAnchor(anchor, specLines) {
  let sectionHeadingText = null;
  if (anchor.section) {
    const sec = findSectionHeading(anchor.section, specLines, anchor.sectionDescriptor || null);
    if (!sec.found) return sectionNotFoundFailure(anchor.section);
    sectionHeadingText = sec.headingLine;
  }
  if (anchor.line < 1 || anchor.line > specLines.length) {
    return {
      valid: false,
      reason: "line-out-of-range",
      evidence: `Spec has ${specLines.length} lines; cited line ${anchor.line} is past EOF.`,
    };
  }
  const content = specLines[anchor.line - 1];
  if (!content || !content.trim()) {
    return {
      valid: false,
      reason: "line-blank",
      evidence: `Line ${anchor.line} is blank.`,
    };
  }
  // Checked after the range/blank guards so an out-of-file line reports the
  // more specific cause rather than "outside the section".
  if (sectionHeadingText !== null) {
    const outside = sectionContainmentFailure(
      anchor,
      specLines,
      sectionHeadingText,
      anchor.line,
      anchor.line,
    );
    if (outside) return outside;
  }
  if (anchor.subject) {
    const needle = normalizeTokenForMatch(anchor.subject);
    const haystack = normalizeTokenForMatch(content);
    if (!haystack.includes(needle)) {
      return {
        valid: false,
        reason: "subject-mismatch",
        evidence: `Line ${anchor.line} does not contain '${anchor.subject}'. Line content: ${content.trim()}`,
      };
    }
  }
  return { valid: true, reason: "line-content-matches", evidence: content.trim() };
}

function verifyLineRangeAnchor(anchor, specLines) {
  let sectionHeadingText = null;
  if (anchor.section) {
    const sec = findSectionHeading(anchor.section, specLines, anchor.sectionDescriptor || null);
    if (!sec.found) return sectionNotFoundFailure(anchor.section);
    sectionHeadingText = sec.headingLine;
  }
  if (anchor.start < 1 || anchor.end > specLines.length || anchor.start > anchor.end) {
    return {
      valid: false,
      reason: "line-range-out-of-bounds",
      evidence: `Range ${anchor.start}-${anchor.end} invalid for spec with ${specLines.length} lines.`,
    };
  }
  // A range must sit ENTIRELY inside the named section — a range that starts
  // above the heading (the Plan-015 T15.1 shape: `lines 79-110` under a section
  // beginning at 81) or spills past its end is describing a different span than
  // the one it names.
  if (sectionHeadingText !== null) {
    const outside = sectionContainmentFailure(
      anchor,
      specLines,
      sectionHeadingText,
      anchor.start,
      anchor.end,
    );
    if (outside) return outside;
  }
  const block = specLines.slice(anchor.start - 1, anchor.end).join("\n");
  if (anchor.subject) {
    // Subject search uses ±2 ambient lines around the cited range so cites
    // pointing at a fenced shape block don't have to widen artificially to
    // include the intro line naming the contract (intro-above-block pattern).
    const ambient = 2;
    const ambientStart = Math.max(1, anchor.start - ambient);
    const ambientEnd = Math.min(specLines.length, anchor.end + ambient);
    const haystackBlock = specLines.slice(ambientStart - 1, ambientEnd).join("\n");
    const needle = normalizeTokenForMatch(anchor.subject);
    const haystack = normalizeTokenForMatch(haystackBlock);
    if (!haystack.includes(needle)) {
      return {
        valid: false,
        reason: "subject-mismatch-in-range",
        evidence: `Lines ${anchor.start}-${anchor.end} (±2 ambient = ${ambientStart}-${ambientEnd}) do not contain '${anchor.subject}'.`,
      };
    }
  }
  return {
    valid: true,
    reason: "line-range-content-matches",
    evidence: block.slice(0, 200),
  };
}

// Locate §Acceptance Criteria inside a spec: its checkbox bullets, the
// character offset its body starts at, and the LINE bounds of that body.
// Factored out of verifyAcAnchor so the ordinal form (`ACn (line MM)`) and
// the by-line form (`AC line N`) share ONE definition of "inside
// §Acceptance Criteria" and cannot drift — the same
// one-transition-function discipline createStructuralScanState applies to
// the two structural scanners. Bullet `.index` values stay relative to
// `bodyStart`, matching the pre-factoring arithmetic exactly. Returns
// `{ found: false }` when the spec carries no §Acceptance Criteria heading.
//
// Heading discovery AND section termination both run through that shared walk.
// Two Codex P2 findings (PR #260 round 1) came from this function having only
// CLAIMED that kinship in the comment above while implementing its own regexes:
//
//   - The heading was located with a raw `/^#+\s+Acceptance Criteria$/m`, so a
//     `## Acceptance Criteria` inside a FENCED example was selectable as the
//     real section. An `AC line N` cite could then verify green against an
//     example bullet in a spec that has no acceptance-criteria section at all —
//     a false clean, the class this PR exists to close.
//   - Termination stopped at the next heading of ANY level, so a legitimate
//     child (`### API criteria`) truncated its own parent, and cites to bullets
//     under that child were rejected as outside the section even though
//     Markdown containment places them inside — a gate reddening correct input.
//
// Walking structurally fixes the first; stopping only at a heading whose level
// is <= the AC heading's fixes the second. Both now match how
// sectionSpansForHeadingText has always computed containment, so the AC path
// and the general §Section path can no longer disagree about the same spec.
function locateAcceptanceCriteria(source) {
  const sourceLines = source.split("\n");
  const headings = [];
  const scanState = createStructuralScanState();
  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    const line = sourceLines[lineIndex];
    if (structuralScanConsumes(scanState, sourceLines, lineIndex) || !/^#{1,6}\s+/.test(line)) {
      continue;
    }
    headings.push({
      lineNumber: lineIndex + 1,
      level: /^(#{1,6})/.exec(line)[1].length,
      text: line,
    });
  }
  const acIndex = headings.findIndex((heading) =>
    /^#{1,6}\s+Acceptance Criteria\s*$/.test(heading.text),
  );
  if (acIndex === -1) return { found: false };
  const acHeading = headings[acIndex];
  const terminator = headings
    .slice(acIndex + 1)
    .find((heading) => heading.level <= acHeading.level);
  const lineStartOffset = (lineNumber) =>
    sourceLines.slice(0, lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0);
  // `bodyStart` sits at end-of-heading-text (before its newline), preserving the
  // pre-factoring offset exactly so bullet `.index` arithmetic is unchanged.
  const bodyStart =
    lineStartOffset(acHeading.lineNumber) + sourceLines[acHeading.lineNumber - 1].length;
  // `lastLineNum` is the last line INSIDE the section, and both callers read it
  // that way (`anchor.line > lastLineNum` => outside) — hence `terminator - 1`,
  // so the bounds never admit the terminator heading line itself and the
  // "section spans X-Y" evidence string names only lines that are in the section.
  const endCharIdx = terminator ? lineStartOffset(terminator.lineNumber) : source.length;
  const lastLineNum = terminator ? terminator.lineNumber - 1 : sourceLines.length;
  const bullets = [...source.slice(bodyStart, endCharIdx).matchAll(/^- \[[ x]\]/gm)];
  return { found: true, bodyStart, bullets, headingLineNum: acHeading.lineNumber, lastLineNum };
}

const AC_SECTION_MISSING_FAILURE = {
  valid: false,
  reason: "ac-section-missing",
  evidence: "No §Acceptance Criteria heading in spec.",
};

// `AC line N` — the by-line acceptance-criterion anchor. Deliberately NOT
// routed through verifyLineAnchor: a plain line anchor proves only
// in-range + non-blank, so admitting the shape that way would let
// `AC line 40` bind arbitrary prose and would make Gate 4 net-LOOSER. These
// are the same three checks verifyAcAnchor's `lineHint` branch applies —
// in-range, inside the §Acceptance Criteria line bounds, and an actual
// `- [ ]` checkbox bullet — plus the descriptor-subject match every line
// anchor carries, so accepting the shape strengthens verification instead.
function verifyAcLineAnchor(anchor, source, specLines) {
  let sectionHeadingText = null;
  if (anchor.section) {
    const sec = findSectionHeading(anchor.section, specLines, anchor.sectionDescriptor || null);
    if (!sec.found) return sectionNotFoundFailure(anchor.section);
    // Bound the line only by a section this anchor ITSELF claims. `section` is
    // sticky across sub-tokens by design, so a sibling's `§` leaks in — and
    // Plan-011 is the live proof: `§Git Hosting Adapter lines 118-152 (…), AC
    // line 175` cites a genuine AC bullet at 175, which holding to the
    // sibling's 118-152 span would have failed. Existence is still checked
    // above either way; only the span claim needs authorship.
    if (anchor.sectionFromPrefix !== false) sectionHeadingText = sec.headingLine;
  }
  const acceptanceCriteria = locateAcceptanceCriteria(source);
  if (!acceptanceCriteria.found) return AC_SECTION_MISSING_FAILURE;
  if (anchor.line < 1 || anchor.line > specLines.length) {
    return {
      valid: false,
      reason: "ac-line-out-of-range",
      evidence: `Spec has ${specLines.length} lines; cited AC line ${anchor.line} is past EOF.`,
    };
  }
  if (
    anchor.line <= acceptanceCriteria.headingLineNum ||
    anchor.line > acceptanceCriteria.lastLineNum
  ) {
    return {
      valid: false,
      reason: "ac-line-outside-section",
      evidence: `Line ${anchor.line} is outside §Acceptance Criteria (section spans lines ${acceptanceCriteria.headingLineNum + 1}-${acceptanceCriteria.lastLineNum}).`,
    };
  }
  // A NAMED section must also contain the cited line. Resolving the heading
  // proves only that it exists somewhere in the spec, so before this check
  // `Spec-001 §Required Behavior AC line 7` was certified whenever line 7 sat
  // under §Acceptance Criteria — the qualifier was decorative and a stale one
  // stayed green (Codex P1, PR #260 round 2). The two bounds compose: the AC
  // bounds above keep the line an acceptance criterion, this keeps the section
  // name honest. Same helper the plain line/line-range anchors use, so a cite
  // naming a nested AC subsection (`§API criteria AC line 9`) still passes —
  // it is contained by both.
  if (sectionHeadingText !== null) {
    const outside = sectionContainmentFailure(
      anchor,
      specLines,
      sectionHeadingText,
      anchor.line,
      anchor.line,
    );
    if (outside) return outside;
  }
  const content = specLines[anchor.line - 1] ?? "";
  if (!/^- \[[ x]\]/.test(content)) {
    return {
      valid: false,
      reason: "ac-line-not-bullet",
      evidence: `Line ${anchor.line} is not an acceptance-criterion bullet. Content: ${content.trim()}`,
    };
  }
  if (anchor.subject) {
    const needle = normalizeTokenForMatch(anchor.subject);
    if (!normalizeTokenForMatch(content).includes(needle)) {
      return {
        valid: false,
        reason: "subject-mismatch",
        evidence: `AC line ${anchor.line} does not contain '${anchor.subject}'. Line content: ${content.trim()}`,
      };
    }
  }
  return { valid: true, reason: "ac-line-bullet-exists", evidence: content.trim() };
}

function verifyAcAnchor(anchor, source, specLines) {
  let sectionHeadingText = null;
  if (anchor.section) {
    const sec = findSectionHeading(anchor.section, specLines, anchor.sectionDescriptor || null);
    if (!sec.found) return sectionNotFoundFailure(anchor.section);
    // Authored-section rule, identical to verifyAcLineAnchor's.
    if (anchor.sectionFromPrefix !== false) sectionHeadingText = sec.headingLine;
  }
  const acceptanceCriteria = locateAcceptanceCriteria(source);
  if (!acceptanceCriteria.found) return AC_SECTION_MISSING_FAILURE;
  const { bodyStart: acStart, bullets } = acceptanceCriteria;
  if (anchor.ac < 1 || anchor.ac > bullets.length) {
    return {
      valid: false,
      reason: "ac-index-out-of-range",
      evidence: `Spec has ${bullets.length} AC bullets; cited AC${anchor.ac} does not exist.`,
    };
  }
  // Hoisted out of the lineHint branch below: the resolved bullet's line is the
  // containment subject for BOTH shapes. `AC4` alone cites no line, so without
  // deriving one there is nothing to hold a named section to — which is exactly
  // how `§Required Behavior AC4` used to pass while counting bullets from
  // §Acceptance Criteria.
  const targetBulletAbsIdx = acStart + bullets[anchor.ac - 1].index;
  const targetBulletLineNum = source.slice(0, targetBulletAbsIdx).split("\n").length;
  // Best-effort line-hint verification: if hint given, the hinted line must
  // (1) be in range, (2) sit INSIDE the §Acceptance Criteria section, and
  // (3) match an AC bullet shape. Without the section bound, a checkbox
  // bullet anywhere else in the spec would false-pass (Codex P2 on PR #96
  // line 1444).
  if (anchor.lineHint) {
    if (anchor.lineHint < 1 || anchor.lineHint > specLines.length) {
      return {
        valid: false,
        reason: "ac-line-hint-out-of-range",
        evidence: `Line hint ${anchor.lineHint} past EOF.`,
      };
    }
    const { headingLineNum, lastLineNum } = acceptanceCriteria;
    if (anchor.lineHint <= headingLineNum || anchor.lineHint > lastLineNum) {
      return {
        valid: false,
        reason: "ac-line-hint-outside-section",
        evidence: `Line ${anchor.lineHint} is outside §Acceptance Criteria (section spans lines ${headingLineNum + 1}-${lastLineNum}).`,
      };
    }
    const hintContent = specLines[anchor.lineHint - 1] ?? "";
    if (!/^- \[[ x]\]/.test(hintContent)) {
      return {
        valid: false,
        reason: "ac-line-hint-not-bullet",
        evidence: `Line ${anchor.lineHint} is not an AC bullet. Content: ${hintContent.trim()}`,
      };
    }
    // Bind the hint to the specific AC-N index: the hinted line must be the
    // N-th `- [ ]` bullet within §Acceptance Criteria. Without this check
    // `Spec-002 AC3 (line 45)` false-passes when line 45 is actually AC1
    // (Codex P2 on PR #96 line 1571).
    if (anchor.lineHint !== targetBulletLineNum) {
      return {
        valid: false,
        reason: "ac-line-hint-wrong-bullet",
        evidence: `Line ${anchor.lineHint} is an AC bullet but not AC${anchor.ac}; AC${anchor.ac} sits at line ${targetBulletLineNum}.`,
      };
    }
  }
  // Named-section containment, checked LAST so the hint-specific diagnostics
  // above keep reporting the more precise cause. Checked on the resolved bullet
  // rather than on `anchor.lineHint`, which covers the hintless `§X AC4` shape
  // and is identical when a hint is present (the wrong-bullet check just proved
  // they are the same line).
  if (sectionHeadingText !== null) {
    const outside = sectionContainmentFailure(
      anchor,
      specLines,
      sectionHeadingText,
      targetBulletLineNum,
      targetBulletLineNum,
    );
    if (outside) return outside;
  }
  return { valid: true, reason: "ac-bullet-exists", evidence: `AC${anchor.ac} bullet found.` };
}

function verifySectionAnchor(anchor, specLines) {
  // Section-only anchors carry the raw `(descriptor)` tail; its first paren
  // group participates in the paren-stripped fallback's cited-suffix
  // agreement rule. Line/range/AC anchors carry the same claim in
  // `sectionDescriptor` instead — the parser consumes a `(suffix)` sitting
  // between the section and the anchor keyword so the anchor still parses.
  const sec = findSectionHeading(anchor.section, specLines, anchor.descriptor || null);
  if (sec.found) return { valid: true, reason: "section-found", evidence: sec.headingLine };
  return sectionNotFoundFailure(anchor.section);
}

// Grammar/format kinds demote to warnings for S/M classes. FAIL-CLOSED polarity:
// this set enumerates what DEMOTES, so any kind not listed — every
// existence-shaped kind (spec-file-not-found/-ambiguous/-unreadable,
// section-not-found, line-out-of-range, line-blank, line-range-out-of-bounds,
// ac-section-missing, ac-index-out-of-range, adr-/arch-doc-/cross-plan-deps
// lookups, *-unconfigured) and any FUTURE kind — stays a hard error for every
// class. Verifier failures arrive with kind = the verify reason (wrapped at the
// verifyFailures.push site in gateTasksBlockCites), so one set covers both the
// parser and verifier layers. Kind strings verified against this file 2026-07-06.
export const G4_GRAMMAR_DEMOTE_KINDS = new Set([
  // parser-layer grammar/format kinds
  "unparseable-cite",
  // NOT unparseable-spec-subanchor: a Spec-NNN cite that parses to NO anchor
  // (e.g. `Spec-999 row 4`) never reaches the verifier, so demoting the parse
  // failure would silently skip the spec-file-not-found HARD check for the
  // exact classes with the least reviewer coverage (Codex, PR #190).
  "compound-range-multi-subject",
  "namespace-violation",
  "spec-namespace-malformed",
  "plan-local-id-as-spec-anchor",
  "plan-local-id-malformed-trailer",
  "plan-local-id-unparseable",
  // NOT here (kept hard for every class): subject-mismatch and
  // subject-mismatch-in-range — those are SEMANTIC failures (the cited line
  // exists but names different behavior), and for an S-class run the only
  // dispatched reviewer is intent-blind on cite content, so demoting them
  // would lose spec coverage entirely (Codex, PR #190).
  // AC line-HINT refinement kinds (the AC bullet itself was found)
  "ac-line-hint-not-bullet",
  "ac-line-hint-out-of-range",
  "ac-line-hint-outside-section",
  "ac-line-hint-wrong-bullet",
]);

export function gateTasksBlockCites(phaseSection, planNumber, phaseNumber, opts = {}) {
  const counts = countCites(phaseSection);
  // Marker floor. The DISPATCH path requires BOTH sides: a phase's `#### Tasks`
  // block carrying one marker is a partial audit, and "audit has not run" is
  // the correct read — that arm stays byte-identical.
  //
  // A COMPLEMENT has no audit output, so the pair requirement is not just
  // unnecessary there, it is a false-clean generator: an out-of-phase block
  // holding only `**Spec coverage:** Spec-999 §Missing` failed the AND, took
  // this early return, and its anchors were never handed to extractCiteAnchors
  // — zero findings, while the report counted that marker as screened. That is
  // the exact CAT-10 shape this screen was built to close, reproduced inside
  // it (Codex P1, PR #262 round 1; confirmed by probe against a negative
  // control that fires on the same cite when a second marker sits beside it).
  // So complements verify whatever anchors are present: ANY marker is enough.
  //
  // ANY MARKER, not any MENTION. Relaxing AND to OR without also tightening
  // what counts as a marker traded one false-clean for another: countCites
  // matches the bare substring `Spec coverage` with no field colon, and a
  // complement is by construction a plan's NARRATIVE region — preamble, prose
  // between phases, appendices — which is exactly where a sentence like "Spec
  // coverage is added by the audit" lives. Under the AND that prose had to
  // coincide twice to matter; under the OR one mention was enough to set
  // hasCiteMarkers, drop the plan out of `markerlessPlans`, and print
  // `cite-swept` + `cite anomalies: none` over a region where
  // extractCiteAnchors verified nothing and the complement denominator stayed
  // zero. So the relaxed arm keys on classifyPhaseMarkers, which is anchored to
  // a FIELD POSITION (bold `**Spec coverage:**`, or a bullet head / inline
  // `;`-`(` delimiter followed by a colon) and therefore cannot be tripped by
  // prose. The strict arm keeps countCites verbatim — the dispatch path is
  // byte-identical by contract (Codex P1, PR #262 round 2).
  const fieldMarkers = classifyPhaseMarkers(phaseSection);
  const hasMarkerFloor =
    opts.requireBothMarkers === false
      ? fieldMarkers.boldSpec + fieldMarkers.unboldSpec > 0 ||
        fieldMarkers.boldInvariant + fieldMarkers.unboldInvariant > 0
      : counts.spec_coverage > 0 && counts.verifies_invariant > 0;
  if (!hasMarkerFloor) {
    return {
      ok: false,
      // No Spec-coverage / Verifies-invariant markers at all — the audit has
      // not run on this phase. The survey uses this to skip it (a missing
      // marker is not a malformed cite); it is distinct from a cite finding.
      hasCiteMarkers: false,
      findings: [],
      halt: [
        "## Preflight halt: tasks-block missing G4 cites",
        "",
        `Plan-${planNumber} Phase ${phaseNumber}'s \`#### Tasks\` block is missing`,
        `\`Spec coverage:\` (${counts.spec_coverage}) or \`Verifies invariant:\``,
        `(${counts.verifies_invariant}) cites. The audit's G4 traceability gate did`,
        `not produce content — re-run the audit before dispatch.`,
        "",
        "Re-deriving task structure from prose discards cites downstream reviewers",
        "depend on (anti-pattern: SKILL.md § Anti-Patterns).",
      ].join("\n"),
    };
  }
  // Semantic anchor check (additive on top of token presence). The repoRoot
  // path is threaded from runPreflight options; specs live under docs/specs/,
  // ADRs under docs/decisions/, arch-docs under docs/architecture/ (recursive),
  // and cross-plan-deps is a single canonical file at
  // docs/architecture/cross-plan-dependencies.md.
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const specsDir = resolve(repoRoot, "docs", "specs");
  const adrsDir = resolve(repoRoot, "docs", "decisions");
  const archDocsDir = resolve(repoRoot, "docs", "architecture");
  const crossPlanDepsFile = resolve(archDocsDir, "cross-plan-dependencies.md");
  const { anchors, failures: parseFailures } = extractCiteAnchors(phaseSection);
  const verifyFailures = [];
  for (const anchor of anchors) {
    const v = verifyAnchorAgainstSpec(anchor, {
      specsDir,
      adrsDir,
      archDocsDir,
      crossPlanDepsFile,
    });
    if (!v.valid) {
      verifyFailures.push({
        kind: v.reason,
        raw: anchor.raw,
        field: anchor.field,
        taskId: anchor.taskId,
        message: v.evidence,
        remediation:
          "Re-run the cite-amendment subagent per docs/operations/plan-implementation-readiness-audit-runbook.md §Cite-Amendment Subagent Prompt Template, applying per-anchor verification.",
        // Verifier failures are always errors — they map directly onto the
        // seven post-mortem defect classes (subject mismatch, phantom
        // section, file missing, out-of-range line).
        severity: "error",
      });
    }
  }
  const allFailures = [...parseFailures, ...verifyFailures];
  // Size-classed tiering (SKILL.md § Size-Classed Ceremony): grammar/format
  // kinds demote to warnings for S/M phases; existence-shaped kinds and any
  // kind outside the fail-closed demote set stay hard for every class. The
  // Gate-4 token-presence floor above stays hard for all classes.
  const demoteGrammar = opts.sizeClass === "S" || opts.sizeClass === "M";
  // Existence floor survives demotion: a no-anchor parse failure (compound
  // range with multi-subject, plan-local id at anchor position, unparseable
  // tail, …) never reaches the verifier, so the spec-file existence check it
  // skipped is re-applied HERE — every Spec-NNN the raw payload names must
  // resolve to exactly one file or the finding stays hard for every class
  // (family closure for Codex rounds 9-10, PR #190).
  const demotionKeepsExistenceFloor = (f) => {
    const named = [...String(f.raw ?? "").matchAll(/\bSpec-(\d{1,4})\b/g)].map((m) => Number(m[1]));
    if (f.spec != null) named.push(Number(f.spec));
    return named.every((num) => findPaddedFiles(specsDir, num).length === 1);
  };
  const demoted = [];
  const blockingFailures = allFailures.filter((f) => {
    if ((f.severity ?? "error") !== "error") return false;
    if (demoteGrammar && G4_GRAMMAR_DEMOTE_KINDS.has(f.kind) && demotionKeepsExistenceFloor(f)) {
      demoted.push(f);
      return false;
    }
    return true;
  });
  if (blockingFailures.length === 0) {
    // `findings` always carries the FULL parse+verify set — demotion moves
    // entries into `warnings` for the dispatch halt path but never filters
    // `findings`. surveyCorpus consumes `findings`, so the armed CI survey is
    // demotion-blind and DELIBERATELY stricter than dispatch for S/M phases
    // (see preflight-contract.md § Deliberately stricter than dispatch).
    return { ok: true, warnings: demoted, findings: allFailures, hasCiteMarkers: true };
  }
  const lines = [
    "## Preflight halt: Gate 4 cite-anchor semantic check failed",
    "",
    `Plan-${planNumber} Phase ${phaseNumber} has ${blockingFailures.length} cite-anchor defect(s).`,
    "Each finding maps to a mechanism clause from the runbook §Subagent Prompt Template",
    "(per-anchor verify / one-per-behavior / Plan-vs-Spec namespace / return-DONE self-verify).",
    "",
  ];
  for (const f of blockingFailures) {
    const where = f.taskId ? `${f.taskId} (${f.field})` : f.field;
    lines.push(`- [${f.kind}] ${where}: ${f.message}`);
    lines.push(`  cite: ${f.raw}`);
    if (f.remediation) lines.push(`  fix:  ${f.remediation}`);
  }
  if (demoted.length > 0) {
    lines.push("");
    lines.push(`Demoted to warnings under size-class ${opts.sizeClass}:`);
    for (const f of demoted) {
      const where = f.taskId ? `${f.taskId} (${f.field})` : f.field;
      lines.push(`- [${f.kind}] ${where}: ${f.message}`);
    }
  }
  lines.push("");
  lines.push("Authoring contract: docs/operations/plan-implementation-readiness-audit-runbook.md");
  lines.push(
    "Verifier contract:  .claude/skills/plan-execution/references/preflight-contract.md §Gate 4 — Cite Anchor Semantic Check",
  );
  return { ok: false, halt: lines.join("\n"), findings: allFailures, hasCiteMarkers: true };
}

// resolvePrecondition signature is additive-backwards-compatible. The four
// existing cases (pr_merged, adr_accepted, plan_phase, cross_plan_carve_out)
// ignore the new params; the audit_status case introduced in this version
// needs phaseSection + phaseNumber to evaluate the substrate_exempt criterion
// (3) check (Spec-AC-empty sentinel + Tasks-block bracket-form conflict). The
// bl_closed case (added for the Plan-003 Phase 3 / NS-32 backlog gate) reads
// only repoRoot — already present — so it too is purely additive. The
// precondition_box_checked case (Codex P1, PR #212 round 4) additionally
// reads planSource, threaded from the phase walk the same way phaseSection is.
export function resolvePrecondition(
  entry,
  { repoRoot = REPO_ROOT, phaseSection, phaseNumber, planSource } = {},
) {
  switch (entry.type) {
    case "pr_merged": {
      const r = runGh(`gh pr view ${entry.ref} --json state`);
      if (!r.ok) return { ok: false, halt: `gh pr view ${entry.ref} failed: ${r.error}` };
      let data;
      try {
        data = JSON.parse(r.out);
      } catch {
        return {
          ok: false,
          halt: `gh pr view ${entry.ref} returned non-JSON: ${r.out.slice(0, 200)}`,
        };
      }
      if (data.state === "MERGED") return { ok: true };
      return { ok: false, halt: `pr_merged ref=${entry.ref} state=${data.state}, expected MERGED` };
    }
    case "adr_accepted": {
      const adrDir = resolve(repoRoot, "docs", "decisions");
      const adrMatches = findPaddedFiles(adrDir, entry.ref);
      if (adrMatches.length === 0) {
        return { ok: false, halt: `${adrLabel(entry.ref)} not found in docs/decisions/` };
      }
      if (adrMatches.length > 1) {
        return {
          ok: false,
          halt: `${adrLabel(entry.ref)} resolves to multiple files in docs/decisions/: ${adrMatches.map((p) => basename(p)).join(", ")}. Rename or remove the duplicate.`,
        };
      }
      const source = readFileSync(adrMatches[0], "utf8");
      const status = extractAdrStatus(source);
      if (status === "accepted") return { ok: true };
      return {
        ok: false,
        halt: `${adrLabel(entry.ref)} Status=${status || "unknown"}, expected accepted`,
      };
    }
    case "plan_phase": {
      const planDir = resolve(repoRoot, "docs", "plans");
      const planMatches = findPaddedFiles(planDir, entry.plan);
      if (planMatches.length === 0) {
        return { ok: false, halt: `${planLabel(entry.plan)} not found in docs/plans/` };
      }
      if (planMatches.length > 1) {
        return {
          ok: false,
          halt: `${planLabel(entry.plan)} resolves to multiple files in docs/plans/: ${planMatches.map((p) => basename(p)).join(", ")}. Rename or remove the duplicate.`,
        };
      }
      const planFile = planMatches[0];
      const source = readFileSync(planFile, "utf8");
      // Mirror Gate 3's set-comparison via the shared classifier. Pre-round-7
      // the resolver matched any phase entry (`some(e.phase === entry.phase)`),
      // which became a partial-ship false-positive when manifest entries
      // moved to task-level granularity (Codex P2 on PR #35 round 7: a single
      // T5.1 entry in Plan-001 Phase 5 satisfied a downstream Plan-001 Phase 5
      // precondition even though T5.5/T5.6 remained unshipped). Same fail-open
      // contract as Gate 3: only future-schema is opaque-pass; everything else
      // halts with an explicit reason.
      const result = classifyPhaseShipment(source, entry.phase);
      switch (result.kind) {
        case "fully_shipped":
        case "manifest_future_schema":
          return { ok: true };
        case "manifest_unparseable":
          return {
            ok: false,
            halt: `${planLabel(entry.plan)} shipment manifest unparseable (${result.reason}); cannot determine Phase ${entry.phase} ship status`,
          };
        case "manifest_invalid_entries":
          return {
            ok: false,
            halt: `${planLabel(entry.plan)} shipment manifest has ${result.entryErrors.length} entries that fail validateEntry (e.g. shipped[${result.entryErrors[0].index}]: ${result.entryErrors[0].errors[0]}); cannot determine Phase ${entry.phase} ship status`,
          };
        case "no_phase_section":
          return {
            ok: false,
            halt: `${planLabel(entry.plan)} Phase ${entry.phase} section not found in plan file`,
          };
        case "no_declared_tasks":
          // Legacy fallback: upstream Tasks block has no task ids. Fall back
          // to phase-presence so plans that shipped before the audit runbook
          // formalized #### Tasks blocks don't fail-loud.
          if (result.phaseHasManifestEntry) return { ok: true };
          return {
            ok: false,
            halt: `${planLabel(entry.plan)} Phase ${entry.phase} has no entry in shipment manifest`,
          };
        case "partially_shipped": {
          // `shipped` is this phase's landed task ids, so an empty array is
          // exactly the zero-shipped case, and "only partially shipped" was a
          // false claim there (Plan-010's manifest is `shipped: []` while the
          // halt asserted partial shipment). Branching keeps the distinction
          // the classifier already hands us; one unified string would be true
          // in both cases but would stop telling the reader whether anything
          // has landed at all.
          const shipStatus =
            result.shipped.length === 0 ? "not yet shipped" : "only partially shipped";
          return {
            ok: false,
            halt: `${planLabel(entry.plan)} Phase ${entry.phase} ${shipStatus} — missing tasks: ${result.missing.join(", ")}`,
          };
        }
        default:
          // Defensive: classifyPhaseShipment kinds are exhaustive today; this
          // branch fires only if a future kind lands without a handler. Halt
          // loudly rather than silently fall through to cross_plan_carve_out.
          return {
            ok: false,
            halt: `unhandled classifyPhaseShipment kind: ${result.kind}`,
          };
      }
    }
    case "plan_unshipped": {
      // Met once the upstream plan has shipped at least one phase/task — i.e.
      // its shipment manifest exists and has ≥1 entry; unmet (and the phase is
      // skipped by the auto-walk) while the upstream is still un-decomposed (no
      // manifest at all). Deliberately COARSE: this answers "has Plan-N started
      // shipping?", not "has the specific cross-tier substrate landed?". The
      // narrow question is unanswerable here because an un-decomposed upstream
      // has no phase/task granularity to point at — that is the whole reason the
      // corpus uses the prose `Plan-NNN Tier M` form rather than `Plan-NNN Phase
      // N merged`. When the upstream IS decomposed and its substrate ships,
      // tighten the dependent precondition to the per-phase `Plan-NNN Phase N
      // merged` form (plan_phase case) for substrate-level precision.
      const planDir = resolve(repoRoot, "docs", "plans");
      const planMatches = findPaddedFiles(planDir, entry.plan);
      if (planMatches.length === 0) {
        return { ok: false, halt: `${planLabel(entry.plan)} not found in docs/plans/` };
      }
      if (planMatches.length > 1) {
        return {
          ok: false,
          halt: `${planLabel(entry.plan)} resolves to multiple files in docs/plans/: ${planMatches.map((p) => basename(p)).join(", ")}. Rename or remove the duplicate.`,
        };
      }
      const manifest = parseManifestBlock(readFileSync(planMatches[0], "utf8"));
      if (manifest.ok && Array.isArray(manifest.shipped) && manifest.shipped.length > 0) {
        return { ok: true };
      }
      return {
        ok: false,
        halt: `${planLabel(entry.plan)} has not shipped yet (no shipment-manifest entries) — cross-tier substrate unavailable`,
      };
    }
    case "external_plan_phase_merged": {
      // Corpus-declared structured form for cross-plan phase gates (Plan-007's
      // R-section YAML blocks already carry it). Two phase shapes:
      //   - integer (`phase: 2`) — identical semantics to the prose-derived
      //     plan_phase entry; delegate.
      //   - remainder string (`phase: R2`) — R-phases are real plan sections
      //     (`### Phase R2 — …`) but can never appear as a manifest phase key
      //     (validateEntry forces positive integers), so phase-key equality is
      //     structurally unanswerable. The checkable truth is TASK-SET
      //     membership: the R-section's declared task ids (T-007r-2-*) must
      //     all appear in the upstream manifest's shipped task lists under
      //     WHATEVER integer phase the R-series ships as. Halts today while
      //     the tasks are unshipped; passes when they land — no manifest
      //     schema change, no upstream renumbering (Codex P2, PR #193 round 4:
      //     the prose-only R2 gate left plan-022 Phase 1 mechanically open).
      if (typeof entry.phase === "number") {
        return resolvePrecondition(
          { type: "plan_phase", plan: entry.plan, phase: entry.phase, status: "merged" },
          { repoRoot },
        );
      }
      if (typeof entry.phase !== "string" || !/^(?:R\d+|\d+[A-Z])$/.test(entry.phase)) {
        return {
          ok: false,
          halt: `external_plan_phase_merged: unsupported phase value ${JSON.stringify(entry.phase)} (expected an integer, "R<n>", or a supplement label like "3B")`,
        };
      }
      const planDir = resolve(repoRoot, "docs", "plans");
      const planMatches = findPaddedFiles(planDir, entry.plan);
      if (planMatches.length === 0) {
        return { ok: false, halt: `${planLabel(entry.plan)} not found in docs/plans/` };
      }
      if (planMatches.length > 1) {
        return {
          ok: false,
          halt: `${planLabel(entry.plan)} resolves to multiple files in docs/plans/: ${planMatches.map((p) => basename(p)).join(", ")}. Rename or remove the duplicate.`,
        };
      }
      const source = readFileSync(planMatches[0], "utf8");
      const section = extractPhaseSection(source, entry.phase);
      if (!section) {
        return {
          ok: false,
          halt: `${planLabel(entry.plan)} has no "### Phase ${entry.phase}" section — cannot evaluate external_plan_phase_merged (fail closed)`,
        };
      }
      const declared = extractDeclaredTaskIds(section);
      if (declared.length === 0) {
        return {
          ok: false,
          halt: `${planLabel(entry.plan)} Phase ${entry.phase} declares no parseable task ids — cannot verify shipment (fail closed)`,
        };
      }
      const manifest = parseManifestBlock(source);
      if (!manifest.ok) {
        return {
          ok: false,
          halt: `${planLabel(entry.plan)} shipment manifest unparseable (${manifest.reason}) — cannot evaluate Phase ${entry.phase} gate`,
        };
      }
      if (manifest.version > MANIFEST_SCHEMA_VERSION) {
        // Opaque-pass, mirroring plan_phase's future-schema disposition.
        return { ok: true };
      }
      // Schema-validate every entry BEFORE trusting its task list — a
      // syntactically parsed but invalid entry (phase: "5" string, bad sha)
      // must halt, mirroring plan_phase's manifest_invalid_entries path;
      // collecting ids from unvalidated entries was fail-open relative to the
      // integer route (Codex P2, PR #192 round 6).
      const invalidEntryIndexes = [];
      for (let i = 0; i < manifest.shipped.length; i++) {
        if (!validateEntry(manifest.shipped[i]).ok) invalidEntryIndexes.push(i);
      }
      if (invalidEntryIndexes.length > 0) {
        return {
          ok: false,
          halt: `${planLabel(entry.plan)} shipment manifest has invalid entries (index ${invalidEntryIndexes.join(", ")}) — fix the manifest before Phase ${entry.phase} can gate on it`,
        };
      }
      const shippedTaskIds = new Set();
      for (const shippedEntry of manifest.shipped) {
        for (const taskId of [].concat(shippedEntry.task ?? [])) {
          if (taskId) shippedTaskIds.add(taskId);
        }
      }
      const missing = declared.filter((taskId) => !shippedTaskIds.has(taskId));
      if (missing.length === 0) return { ok: true };
      return {
        ok: false,
        halt: `${planLabel(entry.plan)} Phase ${entry.phase} not shipped — missing tasks: ${missing.join(", ")}`,
      };
    }
    case "cross_plan_carve_out": {
      const xplanPath = resolve(repoRoot, "docs", "architecture", "cross-plan-dependencies.md");
      let source;
      try {
        source = readFileSync(xplanPath, "utf8");
      } catch (e) {
        return { ok: false, halt: `cross-plan-dependencies.md unreadable: ${e.message}` };
      }
      // Scope the membership check to §5 only. Pre-this-version the resolver
      // used `source.includes(ref)` over the whole file, which passed when
      // the ref appeared in §3 prose or §6 NS-rows even if §5 had no entry.
      const section5 = extractSection5(source);
      if (section5 === null) {
        return {
          ok: false,
          halt: `cross-plan-dependencies.md has no §5 (Canonical Build Order) section; cannot evaluate cross_plan_carve_out`,
        };
      }
      if (section5.includes(String(entry.ref))) return { ok: true };
      return {
        ok: false,
        halt: `cross_plan_carve_out ref=${entry.ref} not present in cross-plan-dependencies.md §5`,
      };
    }
    case "audit_status": {
      // Two values per runbook §Per-Phase Audit Semantics:
      //   - complete: the act of declaring `complete` is the load-bearing
      //     assertion (matches the existing Gate 2 behavior of trusting the
      //     human-set checkbox); evidence_pr + baseline_tag are documentary.
      //   - substrate_exempt: requires three criteria. (1)+(2) are
      //     human-judged at audit time and live in the §5 carve-out entry
      //     itself; (3) is mechanically verified here — Spec coverage
      //     declaration must be explicitly empty in the phase body, and the
      //     Tasks block must not cite Spec coverage in bracketed-list form.
      if (entry.status === "complete") return { ok: true };
      if (entry.status === "substrate_exempt") {
        const xplanPath = resolve(repoRoot, "docs", "architecture", "cross-plan-dependencies.md");
        let xplanSource;
        try {
          xplanSource = readFileSync(xplanPath, "utf8");
        } catch (e) {
          return { ok: false, halt: `cross-plan-dependencies.md unreadable: ${e.message}` };
        }
        const section5 = extractSection5(xplanSource);
        if (section5 === null) {
          return {
            ok: false,
            halt: `cross-plan-dependencies.md has no §5 (Canonical Build Order) section; cannot evaluate audit_status: substrate_exempt`,
          };
        }
        if (!entry.carve_out_ref || !section5.includes(entry.carve_out_ref)) {
          return {
            ok: false,
            halt: `audit_status: substrate_exempt requires carve_out_ref present in cross-plan-dependencies.md §5; "${entry.carve_out_ref ?? "<missing>"}" not found within §5 scope`,
          };
        }
        // Criterion (3) sentinel: phase body explicitly disclaims Spec AC
        // coverage. Three canonical phrasings accepted.
        const specAcSentinel =
          /covers no Spec-\d+ acceptance criteri|covers NO Spec-\d+ AC|substrate is pre-behavior plumbing/i;
        if (!specAcSentinel.test(phaseSection ?? "")) {
          return {
            ok: false,
            halt: `audit_status: substrate_exempt requires phase body to declare 'covers no Spec-NNN acceptance criteria' (or equivalent sentinel: 'covers NO Spec-NNN AC', 'substrate is pre-behavior plumbing'); not found in Phase ${phaseNumber} section. If this phase ships any Spec AC, declare audit_status: complete and run the runbook audit instead.`,
          };
        }
        // Criterion (3) sibling consistency: Tasks-block rows MUST NOT cite
        // Spec coverage in bracketed-list form (`Spec coverage: [...]`).
        // Bracket-form is the audit-runbook G4 traceability cite shape;
        // prose-form mentions (e.g., `Spec coverage: per F-008b-1-06, NO
        // Spec-008 AC at Tier 1`) are not in scope because they describe
        // coverage *absence*. A bracketed value is the affirmative cite.
        const tasksBlock = extractTasksBlock(phaseSection ?? "");
        if (tasksBlock !== null) {
          const specCoverageRe = /Spec coverage:\s*\[([^\]]+)\]/g;
          const conflicts = [];
          let m;
          while ((m = specCoverageRe.exec(tasksBlock)) !== null) {
            const inner = m[1].trim();
            if (inner && inner.toLowerCase() !== "none") conflicts.push(inner);
          }
          if (conflicts.length > 0) {
            return {
              ok: false,
              halt: `audit_status: substrate_exempt conflicts with Tasks-block Spec coverage cites in Phase ${phaseNumber}: ${conflicts.join("; ")}. Either remove the Spec coverage cites (phase is pure substrate) or declare audit_status: complete (phase ships Spec AC and requires full audit).`,
            };
          }
        }
        return { ok: true };
      }
      return {
        ok: false,
        halt: `audit_status.status must be 'complete' or 'substrate_exempt'; got '${entry.status}'`,
      };
    }
    case "bl_closed": {
      // Gate a phase on a backlog item being closed. Used when a phase cannot
      // reach its Exit Criteria until a governance change lands, but that change
      // is neither a merged PR nor an accepted ADR — so no artifact number
      // exists at declaration time to gate on with pr_merged / adr_accepted
      // (Codex #3 on PR #138: Plan-003 Phase 3 / NS-32 is blocked on a Spec-003
      // §Default-Behavior heartbeat-threshold amendment whose PR number is
      // unknowable now, and the threshold value is a spec value, not
      // ADR-worthy). The honest machine-readable primitive that exists at
      // declaration time is the backlog item itself — Codex named it a "backlog
      // gate". ok:true iff BL-NNN's Status reads `completed` — from
      // docs/backlog.md while the item is active, else from the archive
      // (docs/archive/backlog-archive.md) where completed items are swept per
      // the CLAUDE.md backlog discipline. The archive Status is re-parsed, not
      // trusted on presence: any open state (todo / in_progress / blocked), a
      // non-completed archived state (e.g. withdrawn / superseded), an
      // unparseable Status, or an unknown BL fails closed.
      const blId = `BL-${String(entry.ref).padStart(3, "0")}`;
      const backlogPath = resolve(repoRoot, "docs", "backlog.md");
      let backlog;
      try {
        backlog = readFileSync(backlogPath, "utf8");
      } catch (e) {
        return { ok: false, halt: `docs/backlog.md unreadable: ${e.message}` };
      }
      const activeSection = extractBacklogItemSection(backlog, blId);
      if (activeSection !== null) {
        const verdict = judgeBacklogCompletion(activeSection);
        if (verdict.ok) return { ok: true };
        if (verdict.reason === "unparseable") {
          return {
            ok: false,
            halt: `${blId} found in docs/backlog.md but its Status line is unparseable; cannot evaluate bl_closed`,
          };
        }
        return {
          ok: false,
          halt: `${blId} is '${verdict.reason}' in docs/backlog.md, not 'completed' — the governance change this phase depends on has not landed`,
        };
      }
      // Not in the active backlog → check the archive. Completed items are swept
      // there per the CLAUDE.md backlog discipline, but the archive is NOT
      // completed-only (withdrawn / superseded items live there too), so the
      // Status is re-judged with the same rigor as the active path — presence
      // alone must never unblock (Codex P2 on PR #138).
      const archivePath = resolve(repoRoot, "docs", "archive", "backlog-archive.md");
      let archive = "";
      try {
        archive = readFileSync(archivePath, "utf8");
      } catch {
        // Archive absent is not fatal — fall through to the not-found halt.
      }
      const archivedSection = extractBacklogItemSection(archive, blId);
      if (archivedSection !== null) {
        const verdict = judgeBacklogCompletion(archivedSection);
        if (verdict.ok) return { ok: true };
        if (verdict.reason === "unparseable") {
          return {
            ok: false,
            halt: `${blId} found in docs/archive/backlog-archive.md but its Status line is unparseable; cannot evaluate bl_closed`,
          };
        }
        return {
          ok: false,
          halt: `${blId} is '${verdict.reason}' in the archive (docs/archive/backlog-archive.md), not 'completed' — withdrawn/superseded items are archived but did not land`,
        };
      }
      return {
        ok: false,
        halt: `${blId} not found in docs/backlog.md or docs/archive/backlog-archive.md; cannot evaluate bl_closed (mint the backlog item or correct the ref)`,
      };
    }
    case "precondition_box_checked": {
      // Puts a named, phase-scoped `## Preconditions` checkbox on the
      // machine-enforced path. Gate 7's governance scan deliberately matches
      // only the 000-plan-template trio, so a custom scoped box (a
      // bundle-authored task leg, a procurement window) is documentation only
      // until the phase it gates declares this entry. Prefix-matched like the
      // Gate-7 trio (authors append dated notes after the box text). Fail
      // closed on every indeterminate shape — missing section, no matching
      // box, an ambiguous prefix matching several boxes: a declaration error
      // is never a pass. Introduced for the Spec-012 Part-B ask-expiry legs
      // (Plan-012 Phase 2 / Plan-004 Phase 3) — Codex P1, PR #212 round 4:
      // the checkbox alone carried an enforcement claim no gate implemented.
      if (typeof entry.box !== "string" || entry.box.trim() === "") {
        return {
          ok: false,
          halt: `precondition_box_checked: \`box\` must be a non-empty string, got ${JSON.stringify(entry.box)}`,
        };
      }
      if (typeof planSource !== "string") {
        return {
          ok: false,
          halt: "precondition_box_checked: plan source unavailable to the resolver (internal wiring error; fail closed)",
        };
      }
      const section = extractPreconditionsSection(planSource);
      if (section === null) {
        return {
          ok: false,
          halt: `precondition_box_checked: plan has no \`## Preconditions\` section — cannot locate box "${entry.box}" (fail closed)`,
        };
      }
      const matches = [];
      for (const line of section.split("\n")) {
        const box = line.match(/^- \[([ xX])\] \**(.+)$/);
        if (!box) continue;
        if (box[2].startsWith(entry.box)) matches.push({ state: box[1], line });
      }
      if (matches.length === 0) {
        return {
          ok: false,
          halt: `precondition_box_checked: no \`## Preconditions\` box starts with "${entry.box}" (fail closed — fix the entry's prefix or add the box)`,
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          halt: `precondition_box_checked: prefix "${entry.box}" matches ${matches.length} boxes in \`## Preconditions\` — disambiguate the prefix`,
        };
      }
      if (matches[0].state !== " ") return { ok: true };
      const boxLine = matches[0].line;
      return {
        ok: false,
        halt: [
          `precondition_box_checked: box "${entry.box}" is unchecked:`,
          `  ${boxLine.length > 140 ? `${boxLine.slice(0, 137)}...` : boxLine}`,
          "The box records work this phase depends on (see its note). Check the",
          "box only when the gate it names has cleared.",
        ].join("\n"),
      };
    }
    default:
      return { ok: false, halt: `unknown precondition type: ${entry.type}` };
  }
}

// A line that ENDS the preconditions area outright — a heading or a following
// bold paragraph opens a new prose context, and box-shaped lines beyond it are
// not preconditions. Surveyed across all 13 corpus blocks the headings are the
// `#### Tasks` lines (2); a bold paragraph never occurs today but is the same
// kind of structural break.
function terminatesPreconditionBoxes(line) {
  return line.startsWith("#") || line.startsWith("**");
}

// A line that SUSPENDS a checkbox region without ending it: the yaml-block
// apparatus — the ```-fence lines (4 corpus openers) and the
// `<!-- prettier-ignore -->` pragma that precedes most of them (7) — sits
// INSIDE the preconditions area. A box found after one of these, before a
// prose break, is ORPHANED: canonical layout puts the fence after the complete
// checkbox list, and a box stranded below the fence is invisible to any
// list-shaped reading — this gate's fail-open class recurring as a layout
// defect (PR #251 inserted Plan-009 Phase 3's yaml block mid-list and stranded
// two ticked boxes exactly this way). Orphans halt rather than collect:
// collecting would bless the ambiguous layout and re-open the phantom question
// hard suspension settles by construction (nothing between a fence and the
// next prose break is ever silently read as a gate). Deliberately no other
// fence spelling — the surveyed corpus produces only these two shapes.
function suspendsPreconditionBoxes(line) {
  return line.startsWith("```") || line.startsWith("<!--");
}

// The corpus's dominant precondition form is a plural prose header over a
// checkbox list — `**Preconditions.**` — which matches neither the yaml block
// nor the singular `**Precondition:**` line, so Gate 5 read every such phase as
// an undeclared legacy plan and passed it (Codex P1, PR #251 round 2: Plan-009
// Phase 2 resolved eligible with its Plan-006 Phase 3 box unchecked).
//
// `:` and bare spellings are accepted alongside the corpus's `.` — no plan
// writes them today, so they add no matches, only the guarantee that a
// near-miss header cannot reopen the fail-open this function closes.
//
// Every header in the section arms the scan, and each region runs to its own
// terminator: a phase may carry more than one. Indented lines are bullet
// continuations, not structure — they neither end a region nor start a box.
function collectPreconditionBoxes(phaseSection) {
  const boxes = [];
  const orphans = [];
  // idle → nothing armed; collecting → boxes gate; machinery → a fence or
  // pragma suspended the region, so a box here is an orphan (layout defect).
  // A header re-arms collection from any state.
  let state = "idle";
  for (const line of phaseSection.split("\n")) {
    if (/^\*\*Preconditions[.:]?\*\*/.test(line)) {
      state = "collecting";
      continue;
    }
    if (state === "idle" || /^\s/.test(line)) continue;
    if (terminatesPreconditionBoxes(line)) {
      state = "idle";
      continue;
    }
    if (suspendsPreconditionBoxes(line)) {
      state = "machinery";
      continue;
    }
    // Byte-identical to the box pattern `precondition_box_checked` resolves,
    // capital `X` accepted: two readings of one corpus form must not drift.
    const box = line.match(/^- \[([ xX])\] \**(.+)$/);
    if (!box) continue;
    (state === "collecting" ? boxes : orphans).push({ checked: box[1] !== " ", line });
  }
  return { boxes, orphans };
}

// Two independent legs, BOTH of which must pass: the structured entries (yaml
// block, else the singular prose line) and the checkbox scan. Neither disables
// the other. Precedence — resolving only the yaml when a phase has both — would
// retire that phase's human-tracked rows, including the ratification boxes no
// entry type can express (Plan-010 Phase 1 carries three); un-checking one
// later would then gate nothing. Boxes are the record, yaml is enforced depth.
export function gatePreconditions(phaseSection, planFile, phaseNumber, opts = {}) {
  let entries = parsePreconditionsBlock(phaseSection);
  if (entries === null) {
    const lineMatch = phaseSection.match(/\*\*Precondition:\*\*\s*([^\n]+)/);
    // Pass the local plan number so bare `Phase N merged` resolves to
    // `{type: plan_phase, plan: <local>, phase: N}`. Without this thread,
    // same-plan precondition prose drops below the regex and the function
    // silently treats the line as legacy free-form. Unparseable prose and an
    // absent line alike yield no entries — this leg then passes vacuously.
    entries = lineMatch
      ? regexParsePreconditionsLine(lineMatch[1], extractPlanNumber(planFile))
      : [];
  }
  const failures = [];
  for (const entry of entries) {
    const r = resolvePrecondition(entry, opts);
    if (!r.ok) {
      // First failing entry only, as before: this leg's halt text is a contract
      // older than the box scan and stays byte-identical.
      failures.push(
        [
          `Plan ${planFile} Phase ${phaseNumber} declares precondition:`,
          `  ${JSON.stringify(entry)}`,
          "",
          r.halt,
        ].join("\n"),
      );
      break;
    }
  }
  const { boxes, orphans } = collectPreconditionBoxes(phaseSection);
  const unchecked = boxes.filter((box) => !box.checked);
  if (unchecked.length > 0) {
    failures.push(
      [
        `Plan ${planFile} Phase ${phaseNumber} has ${unchecked.length} unchecked precondition ${
          unchecked.length === 1 ? "box" : "boxes"
        }:`,
        ...unchecked.map(
          (box) => `  ${box.line.length > 120 ? `${box.line.slice(0, 117)}...` : box.line}`,
        ),
        "",
        "Tick a box only when the work it names has landed. The boxes gate the",
        "phase in ADDITION to any `preconditions:` yaml block — neither leg",
        "disables the other.",
      ].join("\n"),
    );
  }
  if (orphans.length > 0) {
    // Checked orphans halt too: the layout is the defect. A ticked box below
    // the fence is one un-tick away from gating nothing, silently.
    failures.push(
      [
        `Plan ${planFile} Phase ${phaseNumber} has ${orphans.length} orphaned precondition ${
          orphans.length === 1 ? "box" : "boxes"
        } stranded below the yaml fence:`,
        ...orphans.map(
          (box) => `  ${box.line.length > 120 ? `${box.line.slice(0, 117)}...` : box.line}`,
        ),
        "",
        "Canonical layout puts the `preconditions:` yaml block after the",
        "COMPLETE checkbox list. Move the stranded boxes above the fence,",
        "checked or not — below it they are invisible to the checkbox scan.",
      ].join("\n"),
    );
  }
  if (failures.length === 0) return { ok: true };
  return {
    ok: false,
    halt: ["## Preflight halt: phase precondition unmet", "", failures.join("\n\n")].join("\n"),
  };
}

// ---------- corpus survey (--survey) ----------
//
// Gate 7 — plan status promotion. The corpus promotion gate (CLAUDE.md
// §Current State; AGENTS.md §Doc-First Discipline) admits a plan's first
// code PR only after `review` → `approved`, with review notes addressed.
// Preflight predated mechanical enforcement: Gate 2 verifies the AUDIT
// fact, but nothing verified the PROMOTION fact, so a review-status plan
// with a ticked audit checkbox cleared preflight end-to-end and the
// pipeline would scaffold a code branch off an unpromoted plan (Codex P2,
// PR #193). Reads the header-table `| **Status** | \`x\` |` row (the
// 000-plan-template shape every plan carries). `approved` and `completed`
// pass — a completed plan still halts later at Gate 3 (all phases
// shipped), which is the truthful message for it. A missing or
// unparseable row halts (fail closed). CLI runs default the gate ON;
// --allow-unpromoted is the explicit authoring-time escape for inspecting
// draft/review plans, mirroring --allow-stale-manifest.
export function gateStatusPromotion(planSource, planFile) {
  // Scope the search to the plan header — everything before the first `##`
  // section heading. A whole-document match could hit an embedded example
  // or matrix row (`| **Status** | approved |`) later in the body and
  // green-light a plan whose actual header row is missing — the exact
  // fail-open the gate documents against (Codex P2 round 3).
  const sectionStart = planSource.search(/^## /m);
  const headerRegion = sectionStart === -1 ? planSource : planSource.slice(0, sectionStart);
  const row = headerRegion.match(/^\|\s*\*\*Status\*\*\s*\|\s*`?([a-z][a-z-]*)`?\s*\|/m);
  if (!row) {
    return {
      ok: false,
      halt: [
        "## Preflight halt: plan status unreadable (Gate 7)",
        "",
        `Plan ${planFile} has no parseable header-table Status row`,
        "(expected the 000-plan-template shape: | **Status** | `approved` |).",
        "Fail closed: cannot verify the review → approved promotion gate.",
      ].join("\n"),
    };
  }
  const status = row[1];
  if (status === "approved" || status === "completed") return { ok: true };
  return {
    ok: false,
    halt: [
      "## Preflight halt: plan not promoted (Gate 7)",
      "",
      `Plan ${planFile} header Status is \`${status}\`; code dispatch requires \`approved\`.`,
      "Promotion is the human gate — address review notes, flip the Status row",
      "(CLAUDE.md §When Writing Documents: status promotion is load-bearing),",
      "then re-run. For authoring-time inspection of a draft/review plan, use",
      "--allow-unpromoted (skip is logged to stderr).",
    ].join("\n"),
  };
}

// Gate 7's second check — the plan-governance Preconditions boxes. The
// 000-plan-template §Preconditions trio below is the human-ticked doc-first
// gate (CLAUDE.md §When Writing Documents, AGENTS.md §Doc-First Discipline):
// a W1 spec-amendment flip records `approved → review` on the SPEC and
// re-opens the plan's paired-spec box, but the plan's own header Status stays
// `approved`, so the status row alone green-lights dispatch against an
// un-promoted spec (Codex P2, PR #202). Prefix-matched: authors append dated
// gate notes after the box text (`- [ ] Paired spec is approved — re-opened
// 2026-07-13: …`). Deliberately NOT every unchecked box in the section:
// plans also carry scoped upstream-dependency boxes (Plan-023's "(Tier 8
// remainder only.)" boxes, Plan-024's procurement boxes gating only Phases
// 4-5) whose unchecked state must not halt phases they do not gate — that
// subset gating belongs to per-phase `preconditions:` blocks (Gate 5), where
// the `precondition_box_checked` entry type puts a named scoped box on the
// enforced path. The template quartet's fourth box (plan-readiness audit)
// already halts at Gate 2.
const GOVERNANCE_PRECONDITION_PREFIXES = [
  "Paired spec is approved",
  "Required ADRs are accepted",
  "Blocking open questions are resolved",
];

// Shared section extractor for the two `## Preconditions` scanners — the
// Gate-7 governance-box scan below and the Gate-5 `precondition_box_checked`
// resolver. One regex, one truth: the consumers must never disagree on where
// the section ends (the next `## ` heading or EOF).
export function extractPreconditionsSection(planSource) {
  const m = planSource.match(/^## Preconditions[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  return m ? m[1] : null;
}

export function gatePlanPreconditionBoxes(planSource, planFile) {
  const section = extractPreconditionsSection(planSource);
  if (section === null) return { ok: true };
  const unchecked = [];
  for (const line of section.split("\n")) {
    const box = line.match(/^- \[ \] \**(.+)$/);
    if (!box) continue;
    if (GOVERNANCE_PRECONDITION_PREFIXES.some((prefix) => box[1].startsWith(prefix))) {
      unchecked.push(line.length > 140 ? `${line.slice(0, 137)}...` : line);
    }
  }
  if (unchecked.length === 0) return { ok: true };
  return {
    ok: false,
    halt: [
      "## Preflight halt: plan-governance precondition unchecked (Gate 7)",
      "",
      `Plan ${planFile} has unchecked plan-governance Preconditions box(es):`,
      ...unchecked.map((line) => `  ${line}`),
      "",
      "These 000-plan-template §Preconditions boxes gate ALL code dispatch for",
      "the plan: an unchecked box records that the paired spec / required ADRs /",
      "blocking questions are not in the promoted state code may build on",
      "(AGENTS.md §Doc-First Discipline). Re-check the box only when the gate",
      "its note names has cleared (e.g. a batch spec re-promotion). Scoped",
      "upstream-dependency boxes are not matched by this gate — phase-scoped",
      "gating belongs in per-phase `preconditions:` blocks (the",
      "`precondition_box_checked` entry type names a scoped box). For",
      "authoring-time inspection, use --allow-unpromoted (skip is logged to",
      "stderr).",
    ].join("\n"),
  };
}

// Two-sided anomaly screen over every real plan, institutionalizing the
// omission survey that caught the second-`#### Tasks`-block bug on PR #190
// (an extractor blind spot Codex's 11 rounds had not surfaced). Runs the
// production extractors over docs/plans/NNN-*.md and compares against a
// DELIBERATELY LOOSER raw oracle — a task-shaped line opens as a top-level
// bullet (optional GFM checkbox, 1-3 asterisks) or `#####` heading whose
// bold/heading token BEGINS `T<digit>`/`T-`. Head-anchored on purpose:
// Tasks blocks carry top-level detail bullets (`- **Step:** ... T3.6 ...`,
// Plan-003) that mention task ids in prose — an anywhere-on-line oracle
// flags those as false omissions. Looser than the extractor in exactly the
// dimensions that have failed before: no closing-`**` tail (star-in-title,
// PR #190) and 1-3 asterisks (bold-italic rows), so both historical miss
// classes still surface as omissions. Both directions must reconcile:
//   omission — an oracle line no parsed id appears on (the extractor
//     missed a real task row; the phase-falsely-shipped class);
//   phantom  — a parsed id absent from every oracle line (the extractor
//     invented a task; Gate 3 would see the phase as never shippable).
// The oracle is a screen, not a proof — see the boundary note below.
// Contract: ../references/preflight-contract.md § Survey mode.

// Leading-indent tolerance mirrors taskHeaderMatches deliberately. The oracle is
// an INDEPENDENT line-shape scan — that independence is what makes it a
// cross-check — but independence is about not calling the parser, not about
// disagreeing on where a task row may begin. While the two disagreed, an
// indented row declaring its own id (the `  - **T-007r-3-15 (slice a) …**`
// spelling taskHeaderMatches documents as observed) parsed to a declared id the
// oracle could not see, and surfaced as `[phantom] parsed id on no task-shaped
// row` — a gating anomaly whose message points the reader at the parser when the
// oracle is what missed the row. Fails loud rather than open, so it could not
// manufacture a clean verdict; it manufactured a wrong one (Codex P2, PR #262
// round 2). Measured corpus-neutral when introduced: zero verdict delta.
const SURVEY_ORACLE_RE = /^(?:[ \t]*-\s+(?:\[[ xX]\]\s+)?\*{1,3}T[-\d]|#####\s+T[-\d])/;

// Reconciliation compares HEAD ids exactly, not row substrings. The lineage
// (Codex P2 rounds 2-5): bare `includes` let parsed `T1.1` cover a `T1.10`
// row; a digit-only boundary let `T-025` cover `T-025d-14-1`; and ANY
// whole-row scan lets a parsed `T2.1` cover an unparseable
// `- ***T2.7 — depends on T2.1***` row via the cross-reference in its tail.
// SURVEY_ORACLE_RE only admits id-HEADED rows, so the row's leading task id
// is well-defined: extract it (id chars `[\w.-]`, trailing `.`/`-` prose
// punctuation trimmed) and require EXACT membership both ways. Erring
// toward "not covered" is the fail-closed direction — a false anomaly is
// visible; a false pass is the miss class this screen exists to catch.
function oracleHeadTaskId(line) {
  const match = line.match(/\bT-?\d[\w.-]*/);
  return match ? match[0].replace(/[.-]+$/, "") : null;
}

export function surveyPhase(phaseSection) {
  const ids = extractDeclaredTaskIds(phaseSection);
  const sizeClass = classifyPhaseSize(ids, extractDeclaredFilePaths(phaseSection));
  const block = extractTasksBlock(phaseSection);
  const oracleLines =
    block === null ? [] : block.split("\n").filter((line) => SURVEY_ORACLE_RE.test(line));
  const headIds = new Set(oracleLines.map(oracleHeadTaskId).filter(Boolean));
  const parsedIds = new Set(ids);
  const omissions = oracleLines.filter((line) => !parsedIds.has(oracleHeadTaskId(line)));
  const phantoms = ids.filter((id) => !headIds.has(id));
  return { ids, sizeClass, oracleLines, omissions, phantoms };
}

// Legacy compact-inline plans: each task packs Files / Verifies invariant / Spec
// coverage onto one bullet line (`- **T-…** (…; Verifies invariant: …; Spec
// coverage: …) — prose`), a shape the Gate-4 bold cite extractor cannot parse —
// the marker payload runs to end-of-line through the task prose, so bolding in
// place yields unparseable-cite noise rather than a verified anchor. Their cite
// anomalies are DIVERTED out of the `--enforce-cites` exit (still PRINTED every
// run as visible debt — never a silent skip) until each plan is re-authored into
// the expanded one-marker-per-line form. The divert is KIND-scoped to the legacy
// marker-shape classes (LEGACY_INLINE_EXEMPT_KINDS below); verifier findings on
// parsed cites gate regardless of the exemption. Exact repo-relative paths, not a prefix
// or glob: a renamed plan drops off the list and trips the stale-exemption ratchet
// (see surveyCorpus). Removal owner per file — the list itself is the tracking, no
// backlog item:
//   008       — its Tier-5-remainder readiness audit.
//   023       — its Tier-8 readiness audit.
export const LEGACY_INLINE_CITE_EXEMPT = [
  "docs/plans/008-control-plane-relay-and-session-join.md",
  "docs/plans/023-desktop-shell-and-renderer.md",
];

// Only the two marker-SHAPE classes the compact-inline legacy style PROVABLY
// produces are divertable — the survey-side screens that fire on HOW the markers
// are written, not on what they cite. Verifier findings from parsed cites
// (`section-not-found`, `unparseable-cite`) and hard failures (`cite-check-threw`)
// always GATE, exempt path or not: the exemption hides legacy formatting debt,
// never a broken or unverifiable Spec anchor (Codex P1, PR #214 round 1 — the
// pre-fix divert was kind-blind and suppressed two live `section-not-found`
// findings). `legacy-markers-partial` is the evidence-carrying variant of the
// partial-marker screen: it is emitted only when the partial phase holds ZERO
// bold markers, so the partiality is proven to come from the legacy inline
// shape. A partial phase with any bold marker keeps the plain `markers-partial`
// kind, which is NOT in this set — a half-finished new-grammar restructure of an
// exempt plan gates instead of shipping silently (Codex P2, PR #214 round 2).
export const LEGACY_INLINE_EXEMPT_KINDS = new Set([
  "legacy-unbold-marker",
  "legacy-markers-partial",
  // A section anchor whose heading RESOLVES but carries trailing legacy
  // descriptor words the pre-Gate-4 idiom wrote outside parens (`§Trust
  // Stance — renderer-untrusted enforcement…`). Resolution succeeded, so the
  // debt is formatting-class: divertable on exempt paths (printed per row),
  // hard-gating everywhere else (Codex P2, PR #214 round 5).
  "legacy-inline-descriptor-tail",
]);

// ---------- Inline anchor-existence floor (Codex P2, PR #214 rounds 3-5) ----------
//
// The legacy-inline exemption hides marker SHAPE, but the shape divert alone
// would also hide a broken anchor INSIDE an inline payload (the bold-only
// extractor never parses them, so `; Spec coverage: Spec-007 §Definitely
// Missing` used to surface only as divertable [legacy-unbold-marker]).
//
// Design (round-5 redesign): the floor runs the REAL Gate-4 payload grammar
// (`parseCitePayload`) over each inline payload after two purely-cosmetic
// idiom normalizations (backtick strip; `docs/**/<name>.md` path collapse),
// then verifies every anchor that parses with the REAL verifier at FULL
// fidelity — sections, ACs, line / line-range subanchors, subjects, hints.
// There is deliberately no floor-private token grammar: rounds 3-5 each
// found a claim type a hand-rolled walker under-covered (§ sections, ACn,
// line/lines), which is structural — the real grammar is the only complete
// enumeration of Gate-4 claim types.
//
// Disposition of results:
//   - Parsed anchor, verify VALID → clean.
//   - Parsed section anchor, verify fails, but a longest-prefix of the
//     section resolves uniquely to a real heading (trailing parenthetical on
//     the HEADING side stripped when exact match fails — unique-match
//     guarded, so it can never over-accept):
//       · zero dropped words → clean (the cite is exact modulo the heading's
//         own `(Qualifier)` — e.g. `§Session Membership Management` against
//         `### Session Membership Management (V1 Pairwise)`);
//       · dropped words remain → [legacy-inline-descriptor-tail]: the anchor
//         RESOLVES, the tail is legacy formatting — divertable-but-printed on
//         exempt paths, gating on every other path.
//   - Any other verify failure → gates ALWAYS: file-resolution reasons map to
//     [inline-doc-missing], everything else (section-not-found with no
//     resolving prefix, ac-index-out-of-range, line-out-of-range, …) to
//     [inline-anchor-not-found]. Neither kind is in LEGACY_INLINE_EXEMPT_KINDS.
//   - Parse FAILURES split by semantic class (Codex P2, PR #214 round 8):
//     SHAPE-class kinds (INLINE_SHAPE_PARSE_KINDS — the text simply did not
//     match the strict grammar) are not floor findings; that malformation is
//     exactly the formatting debt the [legacy-unbold-marker] shape count
//     already represents (and that kind gates by itself on non-exempt
//     paths). Every OTHER error-severity parse kind — the parse-time defect
//     classes (namespace-violation, plan-local-id-as-spec-anchor,
//     compound-range-multi-subject) and any future kind, fail-closed —
//     routes to [inline-cite-violation] and gates on every path. And the
//     CLAIMS inside unparsed text do not escape verification (Codex P2,
//     PR #214 round 6): a SECONDARY existence sweep walks the full
//     normalized payload —
//     descriptors, unparsed fragments, post-`;` segments — and verifies
//     every Spec-NNN / ADR-NNN / Plan-NNN / <name>.md label resolves
//     uniquely, plus §Heading / ACn / line-N / row-id tokens under the
//     nearest preceding Spec binding (walker-style: Plan / ADR / .md /
//     cross-plan-deps labels reset the binding — their §/row refs are
//     documentary in the bold grammar). Row claims verify against the
//     bound spec's table first-column ids (round 7). Sweep findings are
//     DEDUPED against the primary pass via
//     coverage sets (a claim the grammar parsed is never re-reported), and
//     residue § tokens share the same salvage/tail classification, so the
//     two layers always agree on what a tail is. Every salvage-dropped tail
//     — primary or residue — is itself re-scanned by the sweep before it is
//     classified as formatting debt, so a checkable claim can never hide in
//     dropped words (round 8). The sweep is existence-
//     level by design — full fidelity (subjects, hints, ranges under
//     sections) remains the primary pass's job, because unparseable text
//     cannot express those couplings.
//
// The BOLD verifier path is untouched; the restructure that converts these
// rows to bold markers moves them onto the full grammar with no floor at all.

// One unbold marker payload per entry, bounded by the compact-inline row
// grammar: the payload ends at the first `;` or `)` at paren depth 0 (the
// task-attribute group delimiter — parenthesized descriptors inside the
// payload balance out) or end of line.
// A depth-0 `;` ends the payload ONLY when it introduces the next compact-
// inline FIELD — the Gate-4 grammar itself uses `;` as a segment separator
// inside one payload, so a bare `; Spec-999 §Missing` continuation must stay
// part of the payload and reach the parser instead of being silently
// truncated (Codex P2, PR #214 round 6).
const INLINE_FIELD_INTRO_RE = /^\s*(?:Files|Verifies invariant|Spec coverage):/;

export function extractInlineCitePayloads(phaseSection) {
  const markerRe = /(?:^\s*[-*]+\s+|[;(]\s*)(Spec coverage|Verifies invariant):(?!\*)/gm;
  const payloads = [];
  // Fence-masked on the same grounds as the bold extractor: the inline anchor
  // floor must not verify — and thereby bless — an example block's cites.
  const scanned = maskNonContentLines(phaseSection);
  // MARKER DETECTION runs over the fence mask COMPOSED WITH the inline-span
  // mask — the same boundary `maskCiteContent` gives the bold extractor, and for
  // the same reason: prose illustrating the compact syntax inside a same-line
  // code span (`` `(Verifies invariant: I-999-1)` ``) is documentation, not
  // audit output. Detected off `scanned` alone it was extracted, parsed, and
  // resolved — the invariant resolver emitted `invariant-plan-not-found` against
  // an example, which is a red gate over text that cites nothing.
  //
  // Detection only. The PAYLOAD BOUNDARY walk below stays on `scanned` and the
  // payload BYTES stay on the raw input, because a masked-view slice would blank
  // the live backticked payloads (`I-008-9, I-008-11, I-008-7c (substrate — the
  // `relay_connections` rows …)` at Plan-008:370 and 31 siblings) before
  // parseCitePayload ever saw them, degrading failures[].raw for the facet
  // roll-up and the existence floor at once.
  const markerView = maskInlineCodeSpans(scanned);
  // LENGTH-PRESERVATION IS LOAD-BEARING, so it is asserted rather than assumed.
  // Every offset below is shared across three views: `match.index` indexes
  // markerView, the boundary walk indexes `scanned`, the slice indexes
  // phaseSection, and `lineNo` — derived by counting newlines in a markerView
  // prefix — is handed to nearestTaskIdAt, which indexes RAW lines. A masker
  // that ever moved a byte would misattribute findings to the wrong task id
  // silently. Throwing is the fail-closed disposition: every caller (the survey
  // units, the inline floor, the invariant resolver, the phase path) treats a
  // throw from this layer as a gating structural failure.
  if (markerView.length !== phaseSection.length) {
    throw new Error(
      `inline marker view is ${markerView.length} bytes for a ${phaseSection.length}-byte section — the cite maskers must preserve length`,
    );
  }
  for (const match of markerView.matchAll(markerRe)) {
    let depth = 0;
    const start = match.index + match[0].length;
    let end = start;
    while (end < scanned.length) {
      const ch = scanned[end];
      if (ch === "\n") break;
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        if (depth === 0) break;
        depth -= 1;
      } else if (ch === ";" && depth === 0 && INLINE_FIELD_INTRO_RE.test(scanned.slice(end + 1))) {
        break;
      }
      end += 1;
    }
    payloads.push({
      field: match[1],
      // Two views over one offset space, same rule as the bold extractor:
      // POSITIONS come from the masked view, payload BYTES from the raw input.
      // Under the current line-granular fence mask the two slices are
      // byte-identical on content lines, so this is not a behavior change —
      // it is the guard that keeps it that way: route `scanned` through the
      // inline-span masker (the fence-tracker unification will) and a
      // masked-view slice would silently blank the ~8 live backticked legacy
      // payloads before parseCitePayload ever saw them, degrading
      // failures[].raw for the facet roll-up and the existence floor at once.
      payload: phaseSection.slice(start, end).trim(),
      lineNo: markerView.slice(0, match.index).split("\n").length,
    });
  }
  return payloads;
}

// Two purely-cosmetic inline-idiom transforms so the real grammar can parse
// what a legacy payload actually claims: backticks are presentation, and a
// `docs/architecture/**/<name>.md` path collapses to the basename form the
// arch-doc namespace parses (findArchDocFiles searches recursively, so the
// collapse is lossless for that namespace — other docs/ trees are NOT
// collapsed; a path-form cite into them stays unparsed shape debt). Nothing
// else is rewritten.
function normalizeInlineIdiom(payload) {
  return payload
    .replace(/`/g, "")
    .replace(/\bdocs\/architecture\/(?:[\w-]+\/)*([\w-]+\.md)\b/g, "$1");
}

// Verifier reasons that mean the cited DOCUMENT did not resolve (missing /
// ambiguous / unreadable file), as opposed to a resolved document whose
// internal anchor failed. Membership routes a floor failure to
// [inline-doc-missing]; everything else is [inline-anchor-not-found] —
// fail-closed: an unrecognized reason still gates, just under the
// anchor-level kind.
const INLINE_DOC_RESOLUTION_REASONS = new Set([
  "spec-file-not-found",
  "spec-file-ambiguous",
  "spec-file-unreadable",
  "adr-file-not-found",
  "adr-file-ambiguous",
  "arch-doc-not-found",
  "arch-doc-ambiguous",
  "cross-plan-deps-file-not-found",
]);

// Error-severity PARSE-failure kinds that are pure SHAPE debt: the token
// stream did not match the strict Gate-4 grammar, which on a legacy
// compact-inline row is exactly the formatting the [legacy-unbold-marker]
// divert already represents; the secondary existence sweep verifies whatever
// claims that unparsed text contains. Every error-severity parse kind
// OUTSIDE this set routes to [inline-cite-violation] and gates on every
// path (Codex P2, PR #214 round 8): the grammar detects three of the seven
// post-mortem defect classes at parse time (namespace-violation,
// plan-local-id-as-spec-anchor, compound-range-multi-subject), and those
// are affirmative Gate-4 policy violations no existence check can
// represent — a denied `Plan-NNN:LLL` line cite existence-checks as a
// clean Plan label. Fail-closed: future error-severity kinds gate unless
// enumerated here; warn-severity kinds never gate — the floor must not be
// stricter than Gate 4 itself is on the bold path.
const INLINE_SHAPE_PARSE_KINDS = new Set([
  "spec-namespace-malformed",
  "unparseable-spec-subanchor",
  "unparseable-cite",
  "plan-local-id-malformed-trailer",
]);

// Salvage classifier for a `section-not-found` verify failure (Codex P2,
// PR #214 round 5): walk the cite-side words longest-prefix-first and match
// each prefix against the spec's real headings, both exact and with a
// trailing parenthetical stripped (`### Session Membership Management (V1
// Pairwise)` matches `§Session Membership Management`). A prefix must match
// exactly ONE heading across both forms — any ambiguity fails the salvage,
// so it can never over-accept. Returns the FULL heading text so the caller
// re-verifies the anchor's primary claim against the real verifier; salvage
// classifies the tail, it never skips a check.
function salvageSectionHeading(spec, section, dirs) {
  const specMatches = findPaddedFiles(dirs.specsDir, spec);
  if (specMatches.length !== 1) return { resolved: false };
  let source;
  try {
    source = readFileSync(specMatches[0], "utf8");
  } catch {
    return { resolved: false };
  }
  const headings = [];
  for (const line of source.split("\n")) {
    if (/^#+\s+/.test(line)) {
      const full = line.replace(/^#+\s+/, "").trim();
      headings.push({ full, stripped: full.replace(/\s*\([^)]*\)\s*$/, "") });
    }
  }
  const words = section.split(/\s+/).filter(Boolean);
  for (let keep = words.length; keep >= 1; keep -= 1) {
    const candidate = normalizeTokenForMatch(words.slice(0, keep).join(" "));
    const hits = headings.filter(
      (heading) =>
        normalizeTokenForMatch(heading.full) === candidate ||
        normalizeTokenForMatch(heading.stripped) === candidate,
    );
    if (hits.length === 1) {
      return { resolved: true, heading: hits[0].full, droppedWords: words.length - keep };
    }
    if (hits.length > 1) return { resolved: false };
  }
  return { resolved: false };
}

// First-column ids of every markdown table row in the spec (separator rows
// dropped). Legacy inline row cites (`Spec-027 rows 4 + 10`, `row 7a`)
// index these ids (Codex P2, PR #214 round 7). Header cells ("#", "Field")
// are harmless residents of the set — cited row ids are digit-led, so they
// can never collide with a header word. Returns null when the spec file
// does not resolve (the label existence check owns that failure).
function specTableRowIds(spec, dirs) {
  const specMatches = findPaddedFiles(dirs.specsDir, spec);
  if (specMatches.length !== 1) return null;
  let source;
  try {
    source = readFileSync(specMatches[0], "utf8");
  } catch {
    return null;
  }
  const rowIds = new Set();
  for (const line of source.split("\n")) {
    if (!line.startsWith("|")) continue;
    const firstCell = (line.split("|")[1] ?? "").trim().replace(/[*`]/g, "");
    if (!firstCell || /^:?-{3,}:?$/.test(firstCell)) continue;
    rowIds.add(firstCell.toLowerCase());
  }
  return rowIds;
}

export function verifyInlineAnchorFloor(phaseSection, { repoRoot = REPO_ROOT } = {}) {
  const dirs = {
    specsDir: resolve(repoRoot, "docs", "specs"),
    adrsDir: resolve(repoRoot, "docs", "decisions"),
    archDocsDir: resolve(repoRoot, "docs", "architecture"),
    crossPlanDepsFile: resolve(repoRoot, "docs", "architecture", "cross-plan-dependencies.md"),
  };
  const plansDir = resolve(repoRoot, "docs", "plans");
  const findings = [];
  for (const { field, payload, lineNo } of extractInlineCitePayloads(phaseSection)) {
    const normalized = normalizeInlineIdiom(payload);
    const { anchors, failures: parseFailures } = parseCitePayload(normalized);
    // Semantic parse violations gate; shape-class parse failures stay the
    // divertable formatting debt the marker-shape counts already represent
    // (see INLINE_SHAPE_PARSE_KINDS).
    for (const failure of parseFailures) {
      if (failure.severity !== "error" || INLINE_SHAPE_PARSE_KINDS.has(failure.kind)) {
        continue;
      }
      findings.push({
        kind: "inline-cite-violation",
        evidence: `inline ${field} (line ${lineNo}): ${String(failure.raw).trim()} — ${failure.kind}: ${failure.message}`,
      });
    }
    // Coverage sets: every claim the PRIMARY pass verified (valid or not) is
    // excluded from the secondary sweep so no defect is double-reported.
    const coveredSpecs = new Set();
    const coveredAdrs = new Set();
    const coveredFiles = new Set();
    const coveredSections = new Set();
    const coveredAcs = new Set();
    const coveredLineStarts = new Set();
    // Specs whose label existence check FAILED anywhere in this payload:
    // §/AC/line/row tokens bound to them are skipped, and the label itself
    // is never re-reported — the doc-missing finding already covers every
    // claim under that document (one defect, one finding — mirrors the
    // parsed side, where a section-only anchor on a missing spec reports
    // once). Shared across every sweep over this payload (full-payload walk
    // and dropped-tail scans) so the layers agree.
    const missingSpecs = new Set();
    for (const anchor of anchors) {
      if (typeof anchor.spec === "number") {
        coveredSpecs.add(anchor.spec);
        if (anchor.section) {
          coveredSections.add(`${anchor.spec}::${normalizeTokenForMatch(anchor.section)}`);
        }
        if (typeof anchor.ac === "number") coveredAcs.add(`${anchor.spec}::AC${anchor.ac}`);
        if (typeof anchor.line === "number")
          coveredLineStarts.add(`${anchor.spec}::${anchor.line}`);
        if (typeof anchor.start === "number") {
          coveredLineStarts.add(`${anchor.spec}::${anchor.start}`);
        }
      }
      if (typeof anchor.adr === "number") coveredAdrs.add(anchor.adr);
      if (anchor.file) coveredFiles.add(anchor.file);
      let verdict = verifyAnchorAgainstSpec(anchor, dirs);
      let droppedWords = 0;
      let salvagedHeading = null;
      if (!verdict.valid && verdict.reason === "section-not-found" && anchor.section) {
        const salvage = salvageSectionHeading(anchor.spec, anchor.section, dirs);
        if (salvage.resolved) {
          // Re-verify with the real heading substituted so the anchor's
          // primary claim (line / line-range / AC / section) still verifies
          // at full fidelity under the salvaged section.
          verdict = verifyAnchorAgainstSpec({ ...anchor, section: salvage.heading }, dirs);
          droppedWords = salvage.droppedWords;
          salvagedHeading = salvage.heading;
          // The dropped tail may hide checkable document / anchor claims
          // (`… and Spec-999 §Missing` — Codex P2, PR #214 round 8): scan it
          // with the existence sweep under this anchor's Spec binding BEFORE
          // the tail is classified as formatting debt. Runs regardless of the
          // re-verify verdict — a failing primary claim does not absolve the
          // tail's claims.
          if (salvage.droppedWords > 0) {
            sweepExistence(
              anchor.section.split(/\s+/).filter(Boolean).slice(-salvage.droppedWords).join(" "),
              anchor.spec,
            );
          }
        }
      }
      if (verdict.valid) {
        if (droppedWords > 0) {
          findings.push({
            kind: "legacy-inline-descriptor-tail",
            evidence: `inline ${field} (line ${lineNo}): ${String(anchor.raw).trim()} — resolves §${salvagedHeading} with ${droppedWords} trailing descriptor word(s); the restructure moves the tail into a parenthesized descriptor`,
          });
        }
        continue;
      }
      findings.push({
        kind: INLINE_DOC_RESOLUTION_REASONS.has(verdict.reason)
          ? "inline-doc-missing"
          : "inline-anchor-not-found",
        evidence: `inline ${field} (line ${lineNo}): ${String(anchor.raw).trim()} — ${verdict.reason}: ${verdict.evidence}`,
      });
    }
    // SECONDARY existence sweep (Codex P2, PR #214 rounds 6-8): binding-aware
    // token walk over a text region — the FULL normalized payload
    // (descriptors, unparsed fragments, post-`;` segments) and, per round 8,
    // every salvage-dropped descriptor tail (which may hide checkable
    // claims). Labels always existence-check (a typo'd document must not
    // hide inside text the grammar rejects or a parsed anchor's descriptor);
    // §/AC/line tokens verify under the nearest preceding Spec binding,
    // walker-style (Plan / ADR / .md labels RESET the binding — their tails
    // are not spec claims); a dropped-tail scan starts from the salvaging
    // anchor's binding. `Plan-NNN` has no Gate-4 namespace, so its existence
    // check lives only here. Everything already covered by a parsed anchor
    // is skipped via the coverage sets above. Declared as a function so the
    // primary loop above can call it on dropped tails (block-scope
    // hoisting); residue-§ tails recurse (bounded: each recursion scans a
    // strict suffix of the previous text).
    function sweepExistence(text, initialSpecBinding) {
      let specBinding = initialSpecBinding;
      // The § capture stops before ` line N` / ` lines` / ` ACn` / ` row(s) N`
      // exactly like the grammar's section prefix does, so those keywords
      // tokenize as their own claims (and dedupe against parsed anchors)
      // instead of polluting the heading text. Row ids are digit-led
      // (`4`, `7a`) with `+` / `/` / `,` list separators — prose uses of the
      // word "rows" ("the relay_connections rows correlate…") never tokenize.
      // A bare `cross-plan-deps` namespace token resets the Spec binding like
      // the other non-spec namespaces: its §N / row M refs are documentary in
      // the bold grammar and must not verify against a stale Spec context.
      const sweepTokenRe =
        /\bSpec-(\d{1,4})\b|\bADR-(\d{1,4})\b|\bPlan-(\d{1,4})\b|\b([\w-]+\.md)\b|\b(cross-plan-deps)\b|\bAC(\d{1,4})\b|\blines?\s+(\d+)(?:\s*-\s*(\d+))?|\brows?\s+(\d+[a-z]?(?:\s*[+/,]\s*\d+[a-z]?)*)|§\s*([^(—"+,;)\n]+?)(?=\s+lines?\s+\d|\s+AC\d|\s+rows?\s+\d|\s*[(—"+,;)\n]|\s*$)/g;
      for (const token of text.matchAll(sweepTokenRe)) {
        if (token[1] !== undefined) {
          specBinding = Number(token[1]);
          if (!coveredSpecs.has(specBinding) && !missingSpecs.has(specBinding)) {
            // Unknown spec-bearing type: the verifier resolves the file, then
            // falls through to its no-spec-type pass — a pure existence check.
            const verdict = verifyAnchorAgainstSpec(
              { type: "spec-file-existence", spec: specBinding, raw: token[0] },
              dirs,
            );
            if (!verdict.valid) {
              missingSpecs.add(specBinding);
              findings.push({
                kind: "inline-doc-missing",
                evidence: `inline ${field} (line ${lineNo}): ${token[0]} — ${verdict.reason}: ${verdict.evidence}`,
              });
            }
          }
        } else if (token[2] !== undefined) {
          specBinding = null;
          if (!coveredAdrs.has(Number(token[2]))) {
            const verdict = verifyAnchorAgainstSpec(
              { type: "adr-section", adr: Number(token[2]), raw: token[0] },
              dirs,
            );
            if (!verdict.valid) {
              findings.push({
                kind: "inline-doc-missing",
                evidence: `inline ${field} (line ${lineNo}): ${token[0]} — ${verdict.reason}: ${verdict.evidence}`,
              });
            }
          }
        } else if (token[3] !== undefined) {
          specBinding = null;
          const planMatches = findPaddedFiles(plansDir, Number(token[3]));
          if (planMatches.length !== 1) {
            findings.push({
              kind: "inline-doc-missing",
              evidence: `inline ${field} (line ${lineNo}): ${token[0]} — plan file resolves to ${planMatches.length} match(es) under docs/plans/`,
            });
          }
        } else if (token[4] !== undefined) {
          specBinding = null;
          if (!coveredFiles.has(token[4])) {
            const verdict = verifyAnchorAgainstSpec(
              { type: "arch-doc", file: token[4], raw: token[0] },
              dirs,
            );
            if (!verdict.valid) {
              findings.push({
                kind: "inline-doc-missing",
                evidence: `inline ${field} (line ${lineNo}): ${token[0]} — ${verdict.reason}: ${verdict.evidence}`,
              });
            }
          }
        } else if (token[5] !== undefined) {
          specBinding = null;
        } else if (token[6] !== undefined) {
          if (
            specBinding !== null &&
            !missingSpecs.has(specBinding) &&
            !coveredAcs.has(`${specBinding}::AC${Number(token[6])}`)
          ) {
            const verdict = verifyAnchorAgainstSpec(
              {
                type: "ac",
                spec: specBinding,
                ac: Number(token[6]),
                lineHint: null,
                section: null,
                subject: null,
                raw: token[0],
              },
              dirs,
            );
            if (!verdict.valid) {
              findings.push({
                kind: "inline-anchor-not-found",
                evidence: `inline ${field} (line ${lineNo}): ${token[0]} (Spec-${String(specBinding).padStart(3, "0")}) — ${verdict.reason}: ${verdict.evidence}`,
              });
            }
          }
        } else if (token[7] !== undefined) {
          if (
            specBinding !== null &&
            !missingSpecs.has(specBinding) &&
            !coveredLineStarts.has(`${specBinding}::${Number(token[7])}`)
          ) {
            const lineAnchor =
              token[8] === undefined
                ? {
                    type: "line",
                    spec: specBinding,
                    section: null,
                    line: Number(token[7]),
                    subject: null,
                    raw: token[0],
                  }
                : {
                    type: "line-range",
                    spec: specBinding,
                    section: null,
                    start: Number(token[7]),
                    end: Number(token[8]),
                    subject: null,
                    raw: token[0],
                  };
            const verdict = verifyAnchorAgainstSpec(lineAnchor, dirs);
            if (!verdict.valid) {
              findings.push({
                kind: "inline-anchor-not-found",
                evidence: `inline ${field} (line ${lineNo}): ${token[0]} (Spec-${String(specBinding).padStart(3, "0")}) — ${verdict.reason}: ${verdict.evidence}`,
              });
            }
          }
        } else if (token[9] !== undefined) {
          // Row claims index the first-column ids of the bound spec's markdown
          // tables (`Spec-027 rows 4 + 10` → rows `4` and `10` of the
          // §Required Behavior table). Each id in the list is its own claim.
          if (specBinding !== null && !missingSpecs.has(specBinding)) {
            const rowIds = specTableRowIds(specBinding, dirs);
            if (rowIds !== null) {
              for (const rowId of token[9]
                .split(/[+/,]/)
                .map((id) => id.trim())
                .filter(Boolean)) {
                if (!rowIds.has(rowId.toLowerCase())) {
                  findings.push({
                    kind: "inline-anchor-not-found",
                    evidence: `inline ${field} (line ${lineNo}): row ${rowId} (Spec-${String(specBinding).padStart(3, "0")}) — row-not-found: no table row with first-column id '${rowId}' in the spec`,
                  });
                }
              }
            }
          }
        } else if (token[10] !== undefined) {
          const heading = token[10].trim();
          if (
            heading &&
            specBinding !== null &&
            !missingSpecs.has(specBinding) &&
            !coveredSections.has(`${specBinding}::${normalizeTokenForMatch(heading)}`)
          ) {
            const paddedBinding = `Spec-${String(specBinding).padStart(3, "0")}`;
            const verdict = verifyAnchorAgainstSpec(
              { type: "section-only", spec: specBinding, section: heading, raw: token[0] },
              dirs,
            );
            if (verdict.valid) continue;
            if (verdict.reason === "section-not-found") {
              const salvage = salvageSectionHeading(specBinding, heading, dirs);
              if (salvage.resolved && salvage.droppedWords === 0) continue;
              if (salvage.resolved) {
                findings.push({
                  kind: "legacy-inline-descriptor-tail",
                  evidence: `inline ${field} (line ${lineNo}): §${heading} (${paddedBinding}) — resolves §${salvage.heading} with ${salvage.droppedWords} trailing descriptor word(s); the restructure moves the tail into a parenthesized descriptor`,
                });
                // Residue tails get the same round-8 dropped-text scan as the
                // primary pass — checkable claims never hide behind a tail.
                sweepExistence(
                  heading.split(/\s+/).filter(Boolean).slice(-salvage.droppedWords).join(" "),
                  specBinding,
                );
                continue;
              }
            }
            findings.push({
              kind: INLINE_DOC_RESOLUTION_REASONS.has(verdict.reason)
                ? "inline-doc-missing"
                : "inline-anchor-not-found",
              evidence: `inline ${field} (line ${lineNo}): §${heading} (${paddedBinding}) — ${verdict.reason}: ${verdict.evidence}`,
            });
          }
        }
      }
    }
    sweepExistence(normalized, null);
  }
  return findings;
}

// Sentinel unit label for the whole-document cite sweep. gateTasksBlockCites
// consumes its `phaseNumber` argument only to build halt prose (the survey
// discards that prose), so a non-numeric label is safe there.
// ---------- Invariant-reference resolution screen ----------

// Second reference channel: `verifies_invariant: [I-024-4]` inside the task-DAG
// and shipment-manifest YAML. Every one of the corpus's 41 such KEY lines sits
// INSIDE a fence, so maskNonContentLines hides them from extractCiteAnchors —
// deliberately: verifying a fenced example's cites is what let a plan with no
// real audit output read as screened (Codex P2, #260 round 2).
//
// Whether a fenced YAML manifest is audit OUTPUT (screen it) or an embedded
// record (leave it) is a policy question about the masking contract, not a
// mechanical one, so this screen does not answer it. It COUNTS the channel and
// reports the number, because the alternative — resolving the bold channel and
// printing a clean verdict — would describe a second channel as checked when it
// was never read. That is the same false-clean shape the screen exists to close,
// so it must not be reintroduced by the screen's own reporting.
//
// The unit counted is a REFERENCE, not a key line: YAML writes the same list
// three ways, and only one of them keeps every id on the key line.
//
//   inline flow      `verifies_invariant: [I-002-1, I-002-2]`
//   block sequence   `verifies_invariant:` + `  - I-024-1` continuation lines
//   wrapped flow     `verifies_invariant:` + `  [` + one id per line + `  ]`
//
// Reading only the key line counted 48 where 67 exist — 19 ids sat on
// continuation lines (14 under Plan-006's wrapped flow list, 5 across Plan-024's
// two block sequences). A disclosure that under-reports the channel it exists to
// disclose is the same false-clean it was written to prevent, one layer in.
//
// The FENCEDNESS ORACLE is applied per COUNTED LINE — `maskedLines[i] !==
// rawLines[i]` on the continuation line itself, never inherited from its key
// line — for the same reason the key-line exclusion below exists: an unfenced
// continuation is a different defect and must not be folded into a count that
// says "fenced". Bytes are always read from the RAW side; the masked side is
// consulted only as that oracle.
// Constructed per call for the same reason as boldCiteMarkerPattern: a shared
// `g` instance carries `lastIndex` between consumers.
const fencedInvariantYamlIdPattern = () => /\bI-?\d[-\dA-Za-z]*\b/g;
const FENCED_INVARIANT_YAML_KEY_RE = /^(\s*)verifies_invariant:(.*)$/;

// Net `[` − `]` across one line, so a wrapped flow list can be followed to its
// closing bracket rather than guessed at by indentation.
function flowBracketDelta(text) {
  let delta = 0;
  for (const character of text) {
    if (character === "[") delta += 1;
    else if (character === "]") delta -= 1;
  }
  return delta;
}

function countFencedInvariantYamlRefs(section) {
  const rawLines = section.split("\n");
  const maskedLines = maskNonContentLines(section).split("\n");
  // The masker is length-preserving, so a line it consumed differs from its raw
  // form iff the raw form had any non-space byte. A whitespace-only line is
  // therefore invisible to the oracle in BOTH directions — see the skip below.
  const isFenced = (index) => maskedLines[index] !== rawLines[index];
  const countIds = (text) => (text.match(fencedInvariantYamlIdPattern()) || []).length;
  let count = 0;
  for (let index = 0; index < rawLines.length; index += 1) {
    const key = FENCED_INVARIANT_YAML_KEY_RE.exec(rawLines[index]);
    if (key === null) continue;
    // Only the MASKED (fenced) ones are out of the bold extractor's reach. An
    // unfenced one would be visible to nothing either, but it is a different
    // defect and must not be silently folded into this count.
    if (!isFenced(index)) continue;
    const [, keyIndent, keyTail] = key;
    count += countIds(keyTail);
    let openBrackets = flowBracketDelta(keyTail);
    // A value that closed on the key line (`[I-001-1]`, `[]`, a bare id) has no
    // continuation to read. An EMPTY tail always does — that is both the block
    // sequence and the wrapped flow list.
    if (openBrackets <= 0 && keyTail.trim() !== "") continue;
    for (let cursor = index + 1; cursor < rawLines.length; cursor += 1) {
      const line = rawLines[cursor];
      // A blank line carries no ids, so skipping it folds nothing unfenced into
      // the count — and it must be skipped rather than treated as the fence's
      // end, because the oracle cannot see it (it masks to itself). The next
      // NON-blank line is oracle-visible and stops the scan if the fence closed.
      if (line.trim() === "") continue;
      if (!isFenced(cursor)) break;
      if (openBrackets > 0) {
        count += countIds(line);
        openBrackets += flowBracketDelta(line);
        if (openBrackets <= 0) break;
        continue;
      }
      const content = line.trimStart();
      // The wrapped-flow opener, on the line AFTER the key.
      if (content.startsWith("[")) {
        count += countIds(line);
        openBrackets += flowBracketDelta(line);
        if (openBrackets <= 0) break;
        continue;
      }
      // Block-sequence members. YAML permits them at or beneath the key's own
      // indent, so the scan ends on a genuine dedent or on the first line that
      // is not a sequence entry (the next mapping key) — never on indentation
      // alone, which would drop the same-indent spelling.
      if (line.length - content.length >= keyIndent.length && /^-\s/.test(content)) {
        count += countIds(line);
        continue;
      }
      break;
    }
  }
  return count;
}

// Resolve one plan's declared invariants, memoized per run.
function loadPlanInvariants(planNumber, repoRoot, cache) {
  if (cache.has(planNumber)) return cache.get(planNumber);
  const matches = findPaddedFiles(resolve(repoRoot, "docs", "plans"), planNumber);
  let entry;
  if (matches.length === 0) {
    entry = { kind: "plan-not-found", ids: [] };
  } else if (matches.length > 1) {
    // Same fail-closed posture as every other findPaddedFiles caller: a numeric
    // prefix collision means we cannot say WHICH plan owns the id.
    entry = { kind: "plan-ambiguous", ids: [], detail: matches.map((p) => basename(p)).join(", ") };
  } else {
    const { ids, hasBlock } = extractDeclaredInvariantIds(readFileSync(matches[0], "utf8"));
    entry = hasBlock
      ? ids.length > 0
        ? { kind: "ok", ids }
        : { kind: "block-unparsed", ids: [] }
      : { kind: "block-absent", ids: [] };
  }
  entry.reported = false;
  cache.set(planNumber, entry);
  return entry;
}

// A facet id (`I-008-7c`) is a sub-clause reference to a DECLARED PARENT, never
// its own declaration: the corpus declares bare `### I-008-7` / `### I-008-12`
// and writes the `a`/`b`/`c`/`d` suffix at the reference site to say WHICH
// sub-clause a task verifies. PLAN_LOCAL_ID_RE ends at `$` with no letter, so a
// facet never becomes an anchor — it lands in `failures` as
// `plan-local-id-unparseable` carrying the offending segment in `.raw`.
//
// The roll-up therefore reads FAILURES, not anchors, and it happens at the
// RESOLUTION layer: nothing about what parses changes and the corpus keeps
// writing the suffix. Widening PLAN_LOCAL_ID_RE would move a GATING path to
// serve a resolution-layer need; normalizing at parse time would erase which
// sub-clause the citing text meant. Both are the wrong layer.
//
// HONEST LIMIT — this resolves the PARENT, not the sub-clause. `I-008-12z`
// rolls up to a declared `I-008-12` and counts exactly like `I-008-12a`,
// because no plan declares its facet letters anywhere a screen can read them.
// The counter is named `parentResolved` for that reason: "the parent is
// declared" is the claim, NOT "the reference is verified" — the sub-clause
// analogue of the accepted-vs-verified line the `none` arm prints.
const FACET_INVARIANT_HEAD_RE = /^(I-\d{3}-\d+(?:-\d+)*)[a-z](?![\w-])/;

// Exported and separately tested: this is a branch whose negative cases CANNOT
// be observed against the corpus — today every `plan-local-id-unparseable` in
// an invariant field is a facet (measured: zero non-facet instances), so a
// wrong `null` arm would fire on nothing and look correct forever. Testing it
// directly is the only thing that pins it.
export function facetBaseId(rawSegment) {
  const match = FACET_INVARIANT_HEAD_RE.exec(String(rawSegment).trim());
  return match ? match[1] : null;
}

// Nearest preceding task id for a legacy compact-inline marker. The slice is
// INCLUSIVE of the marker's own line because the compact-inline shape packs the
// header and the field onto one line (`- **T-008r-1-4** (…; Verifies invariant:
// …)`) — an exclusive slice would attribute every finding to the PREVIOUS task.
// `lineNo` indexes the raw source (verified: 48 of 48 corpus markers land on a
// line that holds the marker text), because the masking that produced it is
// length-preserving.
function nearestTaskIdAt(lines, lineNo) {
  const prefix = lines.slice(0, lineNo).join("\n");
  const match = taskHeaderMatches(prefix).reduce(
    (latest, m) => (latest === null || m.index > latest.index ? m : latest),
    null,
  );
  return match ? match[1] : null;
}

/**
 * Resolve every `Verifies invariant:` reference against the invariants its
 * owning plan actually declares, across BOTH marker channels.
 *
 * Mirrors verifyInlineAnchorFloor's contract (per-section, fail-closed, own
 * findings) rather than threading a plansDir through verifyAnchorAgainstSpec —
 * the resolution needs a document the anchor verifier was built never to have.
 *
 * TWO CHANNELS, REPORTED SEPARATELY, NEVER SUMMED. `extractCiteAnchors` reads
 * only the bold `**Verifies invariant:**` form; the compact-inline form
 * (`- **T-…** (…; Verifies invariant: …)`) is `extractInlineCitePayloads`'s.
 * Screening only the first is how 56 ids across Plan-008 — a plan with ZERO
 * bold markers — reached no screen while the gate printed a clean total. There
 * is deliberately no combined `resolved` field: when the legacy channel is
 * retired its number must go visibly to zero as a CHANNEL CLOSING, not vanish
 * into a total that quietly shrinks.
 *
 * Returns counts alongside findings because a zero finding count is ambiguous
 * between "clean" and "never ran", and these numbers are the ONLY evidence that
 * anything was checked at all.
 */
export function verifyInvariantReferences(
  section,
  { repoRoot = REPO_ROOT, cache = new Map() } = {},
) {
  const findings = [];
  const bold = { resolved: 0, noneArm: 0, parentResolved: 0 };
  const legacy = { resolved: 0, noneArm: 0, parentResolved: 0 };

  // Resolve ONE member id against its owning plan's declared set. Returns whether
  // the member resolved, so the caller can decide the fate of the REFERENCE that
  // produced it. `shown` is the token the author actually wrote (a facet suffix,
  // a range) and `referenceId` is what that token resolved to; for an ordinary
  // single id all three are the same string and every message below is
  // byte-identical to what it was before ranges existed.
  const resolveInvariantMember = (member, tally, taskId, shown, facet, referenceId) => {
    const where = taskId ? `${taskId}: ` : "";
    const planNumber = OWNING_INVARIANT_ID_RE.exec(member)[1];
    const entry = loadPlanInvariants(planNumber, repoRoot, cache);
    if (entry.kind === "ok") {
      if (entry.ids.includes(member)) return true;
      findings.push({
        kind: "invariant-undeclared",
        evidence: `${where}\`${shown}\` is not declared by ${planLabel(planNumber)}${facet ? ` (rolled up to parent \`${referenceId}\`, which is also absent)` : ""}${member === referenceId ? "" : ` (range member \`${member}\`)`} (its \`## Invariants\` block declares ${entry.ids.length}: ${entry.ids.slice(0, 6).join(", ")}${entry.ids.length > 6 ? ", …" : ""})`,
      });
      return false;
    }
    // Structural failures are reported ONCE per owning plan, not once per
    // reference. One unreadable Invariants block would otherwise emit a finding
    // against every innocent line that cites it, burying the single real defect
    // under a flood pointing at the wrong places.
    if (entry.reported) return false;
    entry.reported = true;
    if (entry.kind === "plan-not-found") {
      findings.push({
        kind: "invariant-plan-not-found",
        evidence: `${where}\`${shown}\` names ${planLabel(planNumber)}, which has no \`docs/plans/${planNumber}-*.md\` file`,
      });
    } else if (entry.kind === "plan-ambiguous") {
      findings.push({
        kind: "invariant-plan-ambiguous",
        evidence: `${where}\`${shown}\` names ${planLabel(planNumber)}, which resolves to multiple files (${entry.detail}) — cannot determine the owning declaration set`,
      });
    } else if (entry.kind === "block-absent") {
      findings.push({
        kind: "invariant-block-absent",
        evidence: `${where}\`${shown}\` names ${planLabel(planNumber)}, which has no \`## Invariants\` block — it declares no invariants at all`,
      });
    } else {
      findings.push({
        kind: "invariant-block-unparsed",
        evidence: `${planLabel(planNumber)} has an \`## Invariants\` block that parsed to ZERO ids — the declaration extractor does not recognize its shape, so no reference to this plan can be resolved (references are NOT reported individually)`,
      });
    }
    return false;
  };

  // One resolution core for both channels. `facet` carries the original token
  // when the id arrived via roll-up, so the message names what the author
  // actually wrote rather than a base they never typed.
  //
  // THE UNIT OF COUNT IS THE REFERENCE, NOT THE MEMBER. "575 resolved" means 575
  // citations were checked; a range that expands to five declared members is ONE
  // resolved reference, and a range with a single undeclared member is zero
  // resolved references plus a finding naming that member. Counting members
  // instead would move the census whenever a plan respelled a list as a range,
  // saying nothing about the corpus while looking like it had.
  const resolveInvariantId = (id, tally, taskId, facet) => {
    const where = taskId ? `${taskId}: ` : "";
    const shown = facet ?? id;
    const reference = classifyInvariantReference(id);
    if (reference.kind === "malformed") {
      // Fail closed. Every id in the structured namespace claims an owning plan,
      // so one this screen cannot expand is an unresolved reference — the exact
      // disposition the silent return used to deny it (`I-024-999..1000` passed
      // an armed survey with zero findings because a supported parser spelling
      // met an unsupported resolver shape and nothing spoke in between).
      findings.push({
        kind: "invariant-reference-malformed",
        evidence: `${where}\`${shown}\` is in the structured invariant namespace (\`I-NNN-…\`) but ${reference.reason} — nothing here can be resolved against a declared set`,
      });
      return;
    }
    if (reference.kind === "plan-local") {
      if (PLAN_LOCAL_TEST_ID_RE.test(id)) {
        findings.push({
          kind: "invariant-test-id",
          evidence: `${where}\`${id}\` looks like a test id, not an invariant id — plan test tables declare \`I<n>\` rows (\`## Test And Verification Plan\`), and an invariant id carries its owning plan (\`I-024-4\`). Cite the invariant this task verifies, or \`none\` if it verifies none; do NOT mint an invariant to match \`${id}\`.`,
        });
      }
      // Cn / Pn / Pr-n and a bare In are plan-local by construction: they name
      // no owning document, so there is nothing to resolve them against. That
      // is the true half of the premise at verifyAnchorAgainstSpec.
      return;
    }
    // EVERY member must resolve for the reference to count as resolved, and every
    // failing member reports on its own — a range is a claim about each id it
    // spans, so a partially-declared range is a defect, not a partial credit.
    let everyMemberResolved = true;
    for (const member of reference.ids) {
      if (!resolveInvariantMember(member, tally, taskId, shown, facet, id)) {
        everyMemberResolved = false;
      }
    }
    if (!everyMemberResolved) return;
    tally.resolved += 1;
    if (facet) tally.parentResolved += 1;
  };

  const consumeAnchor = (anchor, tally, taskId) => {
    // `none` is a legitimate, load-bearing value: Plan-003:517 and :525 spell
    // `none (I1 is an AC-coverage test — no Plan-003 invariant exclusively
    // verified here)` for a task that genuinely verifies no invariant. It is
    // ACCEPTED and COUNTED, never verified — see the emit site, where the count
    // is printed as asserted-not-verified debt.
    if (anchor.type === "none-literal") {
      tally.noneArm += 1;
      return;
    }
    if (anchor.type !== "plan-local-id") return;
    resolveInvariantId(anchor.id, tally, taskId, null);
  };

  // Facet roll-up. Keyed on the failure KIND plus a `^`-anchored facet shape, so
  // any OTHER unparseable segment returns null from facetBaseId and is left
  // alone — a roll-up that fired on the wrong failure would mint resolutions out
  // of text nobody checked.
  //
  // Falling out of the roll-up used to mean falling out of the screen. `I-008-7cc`
  // — one keystroke from the live `I-008-7c` — parses to `plan-local-id-unparseable`
  // (warn severity), so the inline floor skips it, Gate 4's blocking filter drops
  // it, and the exemption diverts the marker-shape finding that would otherwise
  // have carried it: `--survey --enforce-cites` accepted a reference to nothing.
  // A non-facet failure in this namespace now reports, fail-closed.
  //
  // SCOPED BY SHAPE, NOT BY CALL SITE, and deliberately narrower than "every
  // parse failure in a Verifies-invariant field". Measured across the corpus, the
  // field carries exactly three parse-failure instances beyond the one live facet:
  // two `unparseable-cite` prose descriptors (`substrate boots` at Plan-023:275,
  // `substrate - the audited primitive libraries …` at Plan-008:456), and the
  // field also carries three Spec-§ references (Plan-023:271/:272/:274) that parse
  // cleanly as spec anchors. Whether the field may name a spec clause at all is a
  // FIELD-CONTENT question under separate adjudication; answering it here would
  // emit non-divertable findings against formatting debt on exempt plans. So the
  // discriminator is the STRUCTURED-INVARIANT NAMESPACE: a token this screen is
  // supposed to resolve and cannot.
  const INVARIANT_FAILURE_LEAD_TOKEN_RE = /^[\w.-]+/;
  const consumeFailure = (failure, tally, taskId) => {
    if (failure.kind !== "plan-local-id-unparseable") return;
    const base = facetBaseId(failure.raw);
    if (base !== null) {
      const token = String(failure.raw)
        .trim()
        .slice(0, base.length + 1);
      resolveInvariantId(base, tally, taskId, token);
      return;
    }
    // The lead token is what parsePlanLocalIdSegment itself tried to read as the
    // id (its own `^([\w.-]+)` capture), so this classifies the same bytes the
    // parser rejected rather than a re-reading of the whole segment.
    const leadToken = INVARIANT_FAILURE_LEAD_TOKEN_RE.exec(String(failure.raw).trim())?.[0] ?? "";
    if (!STRUCTURED_INVARIANT_NAMESPACE_RE.test(leadToken)) return;
    const where = taskId ? `${taskId}: ` : "";
    findings.push({
      kind: "invariant-reference-malformed",
      evidence: `${where}\`${leadToken}\` is in the structured invariant namespace (\`I-NNN-…\`) but did not parse as an invariant id, and it is not a facet reference to a declared parent (\`I-008-7c\` rolls up to \`I-008-7\`) — nothing here can be resolved against a declared set`,
    });
  };

  // ---- Channel 1: bold `**Verifies invariant:**` markers.
  const boldExtract = extractCiteAnchors(section);
  for (const anchor of boldExtract.anchors) {
    if (anchor.field !== "Verifies invariant") continue;
    consumeAnchor(anchor, bold, anchor.taskId);
  }
  for (const failure of boldExtract.failures) {
    if (failure.field !== "Verifies invariant") continue;
    consumeFailure(failure, bold, failure.taskId);
  }

  // ---- Channel 2: legacy compact-inline markers.
  // Disjoint from channel 1 BY CONSTRUCTION: extractInlineCitePayloads's marker
  // regex carries a `(?!\*)` lookahead that excludes the bold spelling, and its
  // lead-in requires `^- ` or `;`/`(`, which the bold form never presents. A
  // section holding both spellings is therefore counted once in each channel and
  // never twice in either — asserted by test, because that is a reading of two
  // regexes agreeing with itself and this screen exists because such readings
  // have been wrong twice.
  const lines = section.split("\n");
  for (const payload of extractInlineCitePayloads(section)) {
    if (payload.field !== "Verifies invariant") continue;
    const taskId = nearestTaskIdAt(lines, payload.lineNo);
    const { anchors, failures } = parseCitePayload(payload.payload);
    for (const anchor of anchors) consumeAnchor(anchor, legacy, taskId);
    for (const failure of failures) consumeFailure(failure, legacy, taskId);
  }

  // No combined `resolved`: see the two-channel note on the doc comment.
  return { findings, bold, legacy, fencedYamlRefs: countFencedInvariantYamlRefs(section) };
}

const WHOLE_DOCUMENT_UNIT_LABEL = "(whole document)";

// Sentinel unit label for a COMPLEMENT unit — a contiguous run of plan source
// that no `### Phase N` section covers. Carries the same `phaseNumber` safety
// argument as the whole-document sentinel above: gateTasksBlockCites reads its
// phase argument only to build halt prose, which the survey discards.
const COMPLEMENT_UNIT_LABEL = "(outside every phase)";

// Bold Gate-4 field markers. Mirrors the `boldMarker` pattern extractCiteAnchors
// scans with, so "markers this plan holds" and "markers the extractor would read"
// are the same population — a divergence here would make the intra-plan coverage
// count describe something other than what the screen actually parses. Only these
// two fields are Gate-4 fields; `**Consumes:**` payloads are never anchor-verified
// anywhere, inside a swept section or out.
// Constructed per call, never shared: the sole consumer drives it with matchAll,
// which seeds its clone from this object's `lastIndex`, so a module-level `g`
// instance would silently start mid-document if any future caller left a
// non-zero index behind.
const boldCiteMarkerPattern = () => /\*\*(?:Spec coverage|Verifies invariant):\*\*/g;

/**
 * Assign each bold-marker offset to the survey unit whose byte range covers it.
 *
 * Split out and exported for ONE reason: the `unswept` count it returns is an
 * invariant assertion, and on today's code paths that invariant holds — phase
 * spans plus their derived complements partition the source, so nothing is left
 * over. A check that cannot be made to fail is a check nobody can trust, so the
 * partition is a pure function over (offsets, units) and its failure mode is
 * reachable from a test by handing it a deliberately holed unit list. The
 * alternative — asserting exhaustiveness only in a comment — is what this whole
 * screen exists to stop doing.
 *
 * `find` (not `filter`) so an overlapping range counts a marker exactly once, in
 * the first unit that claims it. The subtraction this replaced summed per-unit
 * counts, which let an overlap inflate the swept side and mask a real hole.
 *
 * @param {number[]} markerOffsets Match offsets into the masked source.
 * @param {{start?: number, end?: number, isComplement?: boolean}[]} units
 * @returns {{phase: number, complement: number, unswept: number, perUnit: number[]}}
 */
export function partitionMarkerOffsets(markerOffsets, units) {
  const covers = (unit, offset) =>
    unit.start != null && unit.end != null && offset >= unit.start && offset < unit.end;
  const perUnit = units.map(() => 0);
  let phase = 0;
  let complement = 0;
  let unswept = 0;
  for (const offset of markerOffsets) {
    const index = units.findIndex((unit) => covers(unit, offset));
    if (index === -1) {
      unswept += 1;
      continue;
    }
    perUnit[index] += 1;
    if (units[index].isComplement) complement += 1;
    else phase += 1;
  }
  return { phase, complement, unswept, perUnit };
}

/**
 * @param options.runCiteGate - seam for the per-unit Gate-4 cite screen.
 * @param options.runInlineAnchorFloor - seam for the inline anchor-existence floor.
 * @param options.partitionMarkers - seam for the marker/unit partition.
 *
 * Both screens are internally fail-closed: a missing or unreadable spec becomes a
 * `[spec-file-not-found]` FINDING rather than a throw, so no corpus fixture can
 * reach their `catch` arms. Those arms still have to gate correctly — they are
 * what stands between a crashed screen and a green verdict — so they are made
 * reachable by injection, in the same idiom as the `repoRoot` / `specsDir`
 * seams elsewhere in this file. Production callers pass neither.
 *
 * `partitionMarkers` is the same idiom for the same reason. The unit cover is
 * exhaustive by construction — the complement is the phase spans' set difference
 * — so no corpus fixture can produce a leftover marker, which leaves the residual
 * gate that reports one unreachable and therefore unverified. Injecting the
 * partition drives that gate and, more importantly, the terminal
 * uncovered-vs-markerless decision it feeds, which is where the two prior
 * regressions in this area actually lived. Production callers pass nothing.
 */
export function surveyCorpus({
  repoRoot = REPO_ROOT,
  runCiteGate = gateTasksBlockCites,
  runInlineAnchorFloor = verifyInlineAnchorFloor,
  runInvariantReferences = verifyInvariantReferences,
  partitionMarkers = partitionMarkerOffsets,
} = {}) {
  const plansDir = resolve(repoRoot, "docs", "plans");
  const planFileNames = readdirSync(plansDir)
    .filter((name) => /^\d{3}-.+\.md$/.test(name) && !name.startsWith("000-"))
    .sort();
  const reportLines = [];
  const notices = [];
  const anomalies = [];
  // Gate-4 cite findings ride a SEPARATE channel from the two-sided
  // omission/phantom `anomalies` (which the real-corpus guard pins to []).
  // Warn-only by default; `--survey --enforce-cites` folds them into the exit.
  const citeAnomalies = [];
  // Legacy marker-shape anomalies (LEGACY_INLINE_EXEMPT_KINDS) from
  // LEGACY_INLINE_CITE_EXEMPT plans divert here: PRINTED as visible debt but never
  // folded into the --enforce-cites exit. Every other kind gates even on an exempt
  // path. Keyed per plan basename for the stale-exemption ratchet below (a plan
  // clean of the DIVERTED classes fails — its exemption is no longer earning its place).
  const exemptCiteAnomalies = [];
  const exemptAnomalyCount = new Map();
  const distribution = { S: 0, M: 0, L: 0 };
  let phaseCount = 0;
  // Coverage bookkeeping. `cite anomalies: none` is only honest when every plan
  // was actually screened, so the survey reports WHICH plans it reached and how:
  // fallbackPlans rode the whole-document sweep, markerlessPlans were swept but
  // carry no cite markers to verify anywhere (a vacuous pass, named so it cannot
  // masquerade as a verified one — phase-based and whole-document alike),
  // uncoveredPlans is the residual the sweep could not reach at all — and that
  // residual gates through `anomalies`.
  const fallbackPlans = [];
  const markerlessPlans = [];
  const uncoveredPlans = [];
  // Two paths reach "uncovered" — a per-unit cite screen that threw, and the
  // outer per-plan catch — and a plan can hit both in one pass. Deduped by name
  // so the coverage denominator stays a plan count.
  const markUncovered = (planName, reason) => {
    if (uncoveredPlans.some((entry) => entry.name === planName)) return;
    uncoveredPlans.push({ name: planName, reason });
  };
  // Plans counted as swept that nonetheless hold cite markers outside every
  // survey unit — the intra-plan residual the plan-level count cannot express.
  const unsweptMarkerPlans = [];
  // Plans carrying Gate-4 markers OUTSIDE every `### Phase N` section, which the
  // complement units below now screen. This is the screen's non-zero denominator
  // (see the emit site), not a defect list.
  const complementMarkerPlans = [];
  // Complement markers a screen was supposed to judge and did not, because that
  // unit's cite gate threw. Kept OUT of `complementMarkerPlans` so the
  // denominator never counts an unrun screen as coverage.
  const unjudgedComplementPlans = [];
  // Invariant-reference resolution counters. `invariantRefsResolved` is this
  // screen's must-not-be-zero denominator: a finding count of zero is ambiguous
  // between "every reference resolves" and "the screen never ran", and this
  // number tells them apart. The other two are DEBT disclosures, not work done —
  // see the emit site. One cache spans the whole run so each owning plan's
  // `## Invariants` block is parsed once, and so a structural failure on that
  // block is reported once rather than once per citing line.
  const invariantCache = new Map();
  // Per-CHANNEL, never merged: a single total would let the legacy channel drop
  // to zero without the number moving enough to notice.
  const invariantBold = { resolved: 0, noneArm: 0, parentResolved: 0 };
  const invariantLegacy = { resolved: 0, noneArm: 0, parentResolved: 0 };
  let invariantFencedYamlRefs = 0;
  for (const name of planFileNames) {
    // Fail-closed coverage: ANY throw while surveying a plan records it as
    // uncovered and gates, instead of aborting the whole run or — the defect
    // this guards — letting one plan vanish behind a clean verdict.
    //
    // Declared OUTSIDE the try so the per-unit cite-screen catches can reach it.
    // A screen that threw did not judge; its plan is not swept.
    let citeScreenFailure = null;
    try {
      const source = readFileSync(resolve(plansDir, name), "utf8");
      // Route every cite anomaly for this plan: exempt plans divert their legacy
      // marker-shape kinds (LEGACY_INLINE_EXEMPT_KINDS) to the printed
      // exemptCiteAnomalies channel; every other kind — and every non-exempt plan —
      // gates through citeAnomalies.
      const isExempt = LEGACY_INLINE_CITE_EXEMPT.includes(`docs/plans/${name}`);
      const pushCite = (kind, message) => {
        if (isExempt && LEGACY_INLINE_EXEMPT_KINDS.has(kind)) {
          exemptCiteAnomalies.push(message);
          exemptAnomalyCount.set(name, (exemptAnomalyCount.get(name) ?? 0) + 1);
        } else {
          citeAnomalies.push(message);
        }
      };
      const phases = walkPhases(source);
      const phaseSummaries = [];
      // Remainder phases (### Phase R2) and supplement phases (### Phase 3B —
      // the campaign-supplement shape) are invisible to walkPhases by design
      // (the dispatch walker is numeric), but the external_plan_phase_merged
      // gate READS their task ids — a malformed R-task or supplement-task row
      // must not merge behind a green survey and only surface at downstream
      // gate-eval time (Codex P2, PR #192 round 6). Survey them alongside the
      // numeric walk.
      const remainderLabels = [...source.matchAll(/^### Phase (R\d+|\d+[A-Z])\b/gm)].map(
        (m) => m[1],
      );
      const allPhaseLabels = [...phases.map(({ number }) => number), ...remainderLabels];
      // One survey unit per phase label. A plan carrying no phase heading of ANY
      // shape still gets swept — as a single whole-document unit — because the
      // alternative is a false-clean gate verdict: skipping the plan and then
      // printing `cite anomalies: none` reads to a reviewer as "checked and
      // clean" when the truth is "never checked". Keying the fallback on
      // allPhaseLabels (not on `phases`) also covers the remainder-only shape,
      // which the numeric walk alone would drop.
      // A label can match the loose remainder/supplement regex above and STILL
      // fail `extractPhaseSection` — `### Phase R1` with no ` — Title` separator
      // is the shape. Coercing that null to `""` (the `?? ""` this replaces) was
      // this screen's own silent-empty defect, the same class the PR closes
      // elsewhere: the empty unit kept `surveyUnits` nonempty, which permanently
      // suppressed the whole-document fallback below, so every cite under the
      // malformed heading went unparsed and `--survey --enforce-cites` exited 0
      // calling the plan cite-swept (Codex P1, PR #260 round 1).
      //
      // Both halves are needed. Dropping the failed label keeps the cites
      // SCREENED (the fallback can now fire); the anomaly keeps the malformed
      // heading VISIBLE. Reporting alone would leave the cites unread; falling
      // back alone would hide a heading the downstream external_plan_phase_merged
      // gate reads by task id, turning a silent pass here into a confusing
      // failure there.
      const surveyUnits = [];
      // Whether every unit carries a located byte range. Hoisted out of the
      // complement block below because the marker-coverage residual — which now
      // GATES — must know that its partition is derivable before treating a
      // leftover marker as a real hole rather than a symptom of the span that
      // already failed to locate.
      let coverComplete = true;
      // Set by the marker-coverage residual below; CONSUMED by the single
      // uncovered-vs-markerless decision after the unit loop. The residual used
      // to call markUncovered itself, which put a second decision point outside
      // that terminal chain: a plan whose only markers sat in the partition hole
      // reached the `else if` with no unit reporting a marker, so the same run
      // printed it as `uncovered` AND as `swept but no cite markers to verify —
      // vacuous pass`. Routing the reason through one variable makes the
      // contradiction unrepresentable rather than merely absent.
      let partitionHole = null;
      for (const label of allPhaseLabels) {
        const section = extractPhaseSection(source, label);
        if (section == null) {
          // `anomalies`, not `citeAnomalies`: a heading the extractor cannot read
          // is a structural failure of the screen, so it gates without waiting for
          // --enforce-cites — matching the [survey-uncovered] catch arm below.
          anomalies.push(
            `${name} [phase-unextractable] \`### Phase ${label}\` matched the phase-label scan but not the extractor's heading shape; its cites cannot be swept per-phase`,
          );
          continue;
        }
        surveyUnits.push({ label, section, isWholeDocument: false, isComplement: false });
      }
      if (surveyUnits.length === 0) {
        // Still a NOTICE, not an anomaly — the walkPhases gap is real and a
        // dispatch run on this plan exits 2 (fail-closed). The notice names the
        // gap; the sweep below is what keeps the cite verdict honest.
        notices.push(
          allPhaseLabels.length === 0
            ? `${name}: no \`### Phase N\` headings — invisible to walkPhases (dispatch exits 2); cite-swept as one whole-document unit`
            : `${name}: all ${allPhaseLabels.length} phase label(s) failed extraction (see [phase-unextractable] above); cite-swept as one whole-document unit`,
        );
        fallbackPlans.push(name);
        surveyUnits.push({
          label: WHOLE_DOCUMENT_UNIT_LABEL,
          section: source,
          // Byte range in `source`, carried by EVERY unit so the marker-coverage
          // residual below can bucket markers by position against one globally
          // masked view instead of re-masking each unit's text in isolation.
          start: 0,
          end: source.length,
          isWholeDocument: true,
          isComplement: false,
        });
      } else {
        // COMPLEMENT UNITS — every byte no `### Phase N` span covers.
        //
        // Survey units are phase sections, so a plan's preamble, its appendices,
        // and any `### Tier-7 Remainder`-shaped block sit inside a plan the
        // coverage line counts as swept and outside every unit that screens
        // anything. The whole-document fallback cannot rescue them: it fires only
        // at `surveyUnits.length === 0`, so ONE phase heading pins a plan to the
        // per-phase path permanently. Plan-025 is the live instance — 32 of its
        // 42 Gate-4 markers sit above its single phase heading, and screening
        // them surfaces findings the armed survey has never once produced while
        // printing `cite anomalies: none`.
        //
        // The discriminator is POSITION, not heading shape. A fix keyed on which
        // `###` spellings look phase-like would be keyed on the wrong property
        // and would miss the next spelling nobody predicted; complements are
        // derived by SUBTRACTION, so they cover every shape by construction and
        // stay correct when a new one is invented.
        const coveredRanges = [];
        for (const unit of surveyUnits) {
          // extractPhaseSection returns an exact substring that BEGINS with the
          // unique `### Phase <label> — <title>` heading, so a plain indexOf is
          // unambiguous — and, unlike a monotone cursor, it tolerates labels
          // arriving out of document order (remainder and supplement labels are
          // appended after the numeric walk, but `### Phase 3B` sits before
          // `### Phase 4` in the source).
          const at = source.indexOf(unit.section);
          if (at === -1) {
            // Fail CLOSED, and through `anomalies` (unconditional) rather than
            // the cite channel: a span the survey cannot locate makes the
            // complement below a subtraction against an incomplete cover, so it
            // would UNDER-report the unscreened region. Skipping quietly here is
            // this screen's own failure mode — a gate reporting clean over work
            // it did not do — not a judgement about cite quality.
            anomalies.push(
              `${name} [survey-span-unlocatable] Phase ${unit.label} section could not be located in the plan source; complement coverage is not derivable for this plan`,
            );
            coverComplete = false;
            continue;
          }
          unit.start = at;
          unit.end = at + unit.section.length;
          coveredRanges.push([at, at + unit.section.length]);
        }
        if (coverComplete) {
          coveredRanges.sort((a, b) => a[0] - b[0]);
          const gaps = [];
          let cursor = 0;
          for (const [start, end] of coveredRanges) {
            if (start > cursor) gaps.push([cursor, start]);
            cursor = Math.max(cursor, end);
          }
          if (cursor < source.length) gaps.push([cursor, source.length]);
          for (const [start, end] of gaps) {
            const section = source.slice(start, end);
            if (section.trim() === "") continue;
            // Deliberately NOT filtered on marker count. A predicate deciding
            // which gaps "have claims worth screening" would be a hand-chosen
            // proxy standing in for the screens' own judgement — the exact
            // construct this change exists to remove, and the one that has
            // already been wrong three times on this surface. Both screens
            // self-filter (gateTasksBlockCites on hasCiteMarkers, the inline
            // floor on its own field-marker anchors), so a claim-free gap costs
            // two cheap no-ops and buys back zero judgement calls.
            //
            // What each screen actually contributes here, measured at
            // introduction rather than assumed: the bold Gate-4 cite screen is
            // the one doing the work — it finds real anchor defects in this
            // region today. The inline anchor floor finds nothing, because every
            // inline cite payload in the corpus currently sits inside a phase
            // section; its zero is VACUOUS, not clean. It is wired up anyway so
            // that an inline marker authored outside a phase later is screened
            // instead of invisible — which is future-proofing, and must not be
            // read as present coverage.
            //
            // One unit per CONTIGUOUS gap, never one merged unit: concatenating
            // non-adjacent regions would splice unrelated text together and let
            // a cite appear to span the join.
            const startLine = source.slice(0, start).split("\n").length;
            const endLine = startLine + section.split("\n").length - 1;
            surveyUnits.push({
              label: `${COMPLEMENT_UNIT_LABEL} lines ${startLine}-${endLine}`,
              section,
              start,
              end,
              isWholeDocument: false,
              isComplement: true,
            });
          }
        }
      }
      // Intra-plan coverage. `N/M plan(s) cite-swept` counts PLANS, and a plan
      // counts as swept the moment one survey unit exists — but units are phase
      // sections, so a bold cite marker under a non-`Phase` `###` heading (the
      // `### Tier-7 Remainder — …` shape) sits inside a counted plan and outside
      // every unit. The whole-document fallback cannot rescue it: that fires only
      // at `surveyUnits.length === 0`, so ONE phase heading pins the plan to the
      // per-phase path forever. Counting markers here keeps the plan-level number
      // from implying marker-level coverage it does not have — the same reason
      // the coverage line exists at all.
      //
      // Counted by POSITION against one globally masked source, never by
      // re-masking each unit's text (Codex P1, PR #262 round 3). The subtraction
      // this replaces masked the whole document and then masked each unit
      // independently, and fence state does not survive that split: a unit begins
      // with its own fence tracker closed, so a ``` that
      // CLOSES a fence for the whole document OPENS one for the unit, and every
      // marker after it is counted by the whole and masked by the part. The
      // residual then went positive with no coverage hole behind it — a masking
      // artifact, which is exactly why the old comment argued the line had to stay
      // non-gating. Masking once removes the disagreement instead of tolerating
      // it, and that is what lets the residual gate below.
      //
      // maskCiteContent — fences PLUS same-line inline code spans — is the SAME
      // content boundary the per-unit cite gates judge through. Counting here
      // through only the fence layer let an inline-code illustration into the
      // denominator: the complement entry reported it "screened via the
      // complement path" while the unit's gate, masking it, judged nothing —
      // and the same plan landed in `markerlessPlans` as having no markers to
      // verify (Codex P2, PR #262 round 6). Two censuses, one marker,
      // contradictory verdicts. One boundary ends the disagreement.
      //
      // Layer safety: both maskers replace bytes with spaces of equal length,
      // so the masked copy stays byte-for-byte offset-identical to `source`
      // and a unit's `[start, end)` indexes the same bytes in both. The fence
      // layer must be applied globally (fence state does not survive per-unit
      // splits — see above); the inline-span layer is line-local, so global
      // and per-unit application cannot disagree on it.
      // Bucketing each match START offset assigns every marker to at most one unit
      // even if a future extractor overlapped two ranges, so no clamp is needed
      // and — unlike the subtraction — an overlap can no longer hide a hole by
      // double-counting the swept side.
      const maskedSource = maskCiteContent(source);
      const markerOffsets = [...maskedSource.matchAll(boldCiteMarkerPattern())].map(
        (match) => match.index,
      );
      const totalMarkers = markerOffsets.length;
      // Only the residual and the per-unit counts are consumed here. The
      // partition also reports phase/complement totals, but the complement
      // DENOMINATOR deliberately does not come from them: those count markers a
      // unit CONTAINS, and the denominator must count markers a screen JUDGED,
      // which is only knowable once that unit's gate has run.
      const { unswept: unsweptMarkers, perUnit: unitMarkerCounts } = partitionMarkers(
        markerOffsets,
        surveyUnits,
      );
      // Markers no unit's byte range covers. With one masking pass this is no
      // longer a count that two disagreeing maskers can manufacture: it is a
      // genuine hole in the phase-spans-plus-their-complement partition, i.e.
      // bytes carrying Gate-4 markers that reached no screen at all. That is this
      // screen's own failure mode, so it FAILS CLOSED through `anomalies`
      // (unconditional) rather than waiting for --enforce-cites to be armed —
      // matching [survey-span-unlocatable] and [cite-check-threw], the sibling
      // structural failures, and NOT the cite channel, which judges cite quality.
      // The plan also loses its swept status: markers went unjudged, so calling it
      // covered is the same false-clean the disclosure was meant to expose.
      //
      // Expected to be ZERO on every current path — the complement is derived by
      // subtraction, so the cover is exhaustive by construction and this is an
      // invariant check, not a routine finding. Written as a gate anyway because
      // the exhaustiveness argument is exactly the kind of reasoning that stops
      // being true after an unrelated edit to gap construction or span extraction,
      // and the failure it would produce is silent. partitionMarkerOffsets is
      // exported so the assertion is falsifiable from a test rather than only
      // arguable from this comment.
      //
      // Suppressed when a phase span failed to locate: that already fired a louder
      // anomaly, the partition is known non-derivable, and re-reporting the same
      // root cause as an independent hole would double-count one failure.
      if (unsweptMarkers > 0 && coverComplete) {
        unsweptMarkerPlans.push({ name, unswept: unsweptMarkers, total: totalMarkers });
        anomalies.push(
          `${name} [markers-unswept] ${unsweptMarkers} of ${totalMarkers} bold Gate-4 marker(s) fall outside every phase span AND outside their complement; the cite partition is not exhaustive and those markers reached no screen`,
        );
        // Recorded, not marked: the single markUncovered decision lives in the
        // terminal chain after the unit loop, where it can also see whether a
        // screen threw. See the `partitionHole` declaration for why.
        partitionHole = `${unsweptMarkers} bold Gate-4 marker(s) reached no survey unit`;
      }
      // Vacuous-pass tracking is per PLAN, not per unit, and deliberately NOT
      // restricted to the whole-document fallback. A plan whose units carry no
      // cite marker anywhere was swept without a single claim being checked, and
      // the coverage line counts it as swept either way. Gating this on
      // `isWholeDocument` left the phase-based spelling of the same emptiness
      // undisclosed: a plan with `### Phase` headings never takes the fallback
      // (that fires only at `surveyUnits.length === 0`), every markerless phase
      // is skipped by `hasCiteMarkers`, and nothing recorded it — so it landed
      // inside `N/N plan(s) cite-swept, 0 uncovered` with zero anomalies. That
      // is the fourth path the coverage contract says cannot exist. Plan-028 is
      // the live instance: five phases, zero markers, previously invisible.
      let planHasAnyCiteMarker = false;
      // The complement denominator is accumulated DURING the loop and published
      // after it, keyed on whether each unit's bold cite gate actually ran
      // (Codex P2, PR #262 round 3). Recording it before the loop let
      // formatSurvey report markers as "screened via the complement path" on a
      // plan whose complement screen had thrown: the outer bookkeeping correctly
      // marked the plan uncovered, but the denominator line kept asserting the
      // screen succeeded — a gate reporting clean over work it did not do, inside
      // the very observable built to expose that. Failed units are tracked
      // separately rather than collapsing the whole plan's entry, so with several
      // complement units the report names WHICH markers went unjudged instead of
      // silently dropping a number.
      //
      // Keyed on the bold gate specifically because these ARE its markers; the
      // inline anchor floor screens a different population (unbold payloads) and
      // its own failure is disclosed through its own [cite-check-threw] anomaly.
      let complementMarkersScreened = 0;
      let complementUnitsScreened = 0;
      let complementMarkersUnjudged = 0;
      let complementUnitsUnjudged = 0;
      for (const [unitIndex, unit] of surveyUnits.entries()) {
        const { label, section, isWholeDocument, isComplement } = unit;
        // Same assignment the residual above was derived from, so the denominator
        // and the residual can never disagree about which unit owns a marker.
        const unitMarkerCount = unitMarkerCounts[unitIndex];
        const unitPrefix = isWholeDocument
          ? `${name} ${WHOLE_DOCUMENT_UNIT_LABEL}`
          : isComplement
            ? `${name} ${label}`
            : `${name} Phase ${label}`;
        // surveyPhase reconciles task-shaped rows against parsed task ids. It
        // runs for phase units and for the whole-document fallback (which stands
        // in for a plan's phases), but NOT for complements: a complement is by
        // construction the region outside every phase, so it has no dispatchable
        // task set to reconcile. Running it there would read whatever task-shaped
        // rows a remainder block or an appendix happens to carry and report them
        // as omissions against a phase that does not exist — through `anomalies`,
        // which gates unconditionally. The cite screens below are
        // position-independent and DO run on complements; that is why complements
        // are constructed at all.
        if (!isComplement) {
          const result = surveyPhase(section);
          // Phase-shaped metrics count real phases only: a whole-document unit is
          // a coverage device, not a dispatchable phase, and folding it in would
          // report a size class for something that never gets dispatched.
          if (!isWholeDocument) {
            phaseCount += 1;
            distribution[result.sizeClass] += 1;
            phaseSummaries.push(`P${label} ${result.sizeClass}(${result.ids.length})`);
          }
          for (const line of result.omissions) {
            anomalies.push(`${unitPrefix} [omission] task-shaped row not parsed: ${line.trim()}`);
          }
          for (const id of result.phantoms) {
            anomalies.push(`${unitPrefix} [phantom] parsed id on no task-shaped row: ${id}`);
          }
        }
        // Per-unit Gate-4 cite screen (all kinds), written to citeAnomalies.
        // Fail-closed: a thrown gate is itself an anomaly, never a silent skip.
        // Units whose Tasks block carries no cite markers (audit-not-run) are
        // skipped — hasCiteMarkers guards that.
        let citeResult;
        try {
          citeResult = runCiteGate(section, name.slice(0, 3), label, {
            repoRoot,
            // Complements verify whatever markers they carry; phases still
            // require the complete pair. See the marker-floor comment in
            // gateTasksBlockCites for why the asymmetry is load-bearing.
            requireBothMarkers: !isComplement,
          });
        } catch (err) {
          // `anomalies`, not `pushCite`. A gate that THREW did not judge cite
          // quality — it failed to run, which is a structural failure of the
          // screen itself, the same class the outer catch routes here. Left in
          // `citeAnomalies` it waits for --enforce-cites to be armed, so a plain
          // `--survey` run would exit 0 over a unit that was never screened.
          const reason = String(err?.message ?? err).slice(0, 160);
          anomalies.push(`${unitPrefix} [cite-check-threw] ${reason}`);
          citeScreenFailure ??= `cite screen threw on ${unitPrefix}: ${reason}`;
          citeResult = null;
        }
        // Denominator bookkeeping, recorded at the ONLY point where "did this
        // unit's bold cite screen run?" is knowable. `citeResult === null` means
        // the gate threw; a non-null result means it judged this unit's markers —
        // including the hasCiteMarkers-false case, which is a real verdict
        // ("nothing here to verify"), not a skipped screen.
        if (isComplement) {
          if (citeResult === null) {
            complementUnitsUnjudged += 1;
            complementMarkersUnjudged += unitMarkerCount;
          } else {
            complementUnitsScreened += 1;
            complementMarkersScreened += unitMarkerCount;
          }
        }
        if (citeResult?.hasCiteMarkers) planHasAnyCiteMarker = true;
        if (citeResult?.hasCiteMarkers) {
          for (const finding of citeResult.findings) {
            const where = finding.taskId ? `${finding.taskId} (${finding.field})` : finding.field;
            pushCite(finding.kind, `${unitPrefix} [${finding.kind}] ${where}: ${finding.raw}`);
          }
        }
        // W3/W4 marker-coverage screen (survey-only; the dispatch gate above is
        // byte-identical). classifyPhaseMarkers is line-anchored, so a narrative
        // "Spec coverage" prose mention trips neither check. Skipped when the gate
        // threw (that unit already carries a [cite-check-threw] anomaly).
        //
        // The two checks below are split by whether their predicate is about
        // AUDIT OUTPUT or about EXTRACTOR REACH — they are not interchangeable,
        // and running both phase-only was the bug (Codex P1, PR #262 round 1).
        //
        // W4 legacy-unbold asks "does this region hold markers whose anchors the
        // bold extractor cannot parse?" That question is well-posed anywhere
        // text carries markers. countCites reads bare substrings, so it counts
        // unbold markers and clears the floor, while extractCiteAnchors parses
        // only the bold shape — leaving a region that reads as screened with
        // nothing actually verified. That false-clean does not care whether the
        // text sits inside a phase, so W4 runs on EVERY unit, complements
        // included.
        //
        // W3 partial-marker asks "did the audit emit a complete marker PAIR for
        // a dispatchable phase?" That predicate genuinely has no referent in a
        // complement — there is no audit output there to be complete or partial
        // — so a remainder block carrying a lone `**Spec coverage:**` summary
        // row would be reported as a partial audit that never happened, through
        // a channel that turns red under --enforce-cites. W3 stays phase-only.
        //
        // Residual, stated plainly and now much smaller: marker-PAIR
        // completeness inside complement regions is deliberately unscreened.
        // Every anchor a complement marker carries IS verified — one-sided
        // included, per the marker floor in gateTasksBlockCites.
        if (citeResult) {
          const markers = classifyPhaseMarkers(section);
          const realSpec = markers.boldSpec + markers.unboldSpec;
          const realInvariant = markers.boldInvariant + markers.unboldInvariant;
          // W4 legacy-unbold: inline/unbold field markers are invisible to the
          // bold cite extractor, so their anchors are never verified — a
          // false-green audit (the Plan-008 inline style). countCites can read
          // > 0 and the extractor still parse nothing.
          const unboldMarkers = markers.unboldSpec + markers.unboldInvariant;
          if (unboldMarkers > 0) {
            pushCite(
              "legacy-unbold-marker",
              `${unitPrefix} [legacy-unbold-marker] ${unboldMarkers} unbold field marker(s) the bold cite extractor does not parse (bold present: ${markers.boldSpec} Spec + ${markers.boldInvariant} invariant)`,
            );
          }
          // W3 partial-marker: exactly one field-marker side present is a partial
          // audit output (the other side silently dropped). Both sides zero is a
          // genuine audit-not-run skip; both present is a complete pair.
          // Evidence-split (Codex P2, PR #214 round 2): a partial unit with ZERO
          // bold markers is proven legacy-inline debt ([legacy-markers-partial],
          // divertable on exempt paths); ANY bold marker in a partial unit is
          // new-grammar authoring that must land the complete pair, so it keeps
          // the always-gating [markers-partial] kind even on an exempt path.
          if (!isComplement && realSpec > 0 !== realInvariant > 0) {
            const present = realSpec > 0 ? "Spec coverage" : "Verifies invariant";
            const missing = realSpec > 0 ? "Verifies invariant" : "Spec coverage";
            const boldMarkers = markers.boldSpec + markers.boldInvariant;
            const kind = boldMarkers === 0 ? "legacy-markers-partial" : "markers-partial";
            const evidence =
              boldMarkers === 0
                ? "all markers unbold — the legacy inline shape"
                : `${boldMarkers} bold marker(s) present — new-grammar authoring must complete the pair`;
            pushCite(
              kind,
              `${unitPrefix} [${kind}] has a ${present} marker but no ${missing} marker (${evidence})`,
            );
          }
        }
        // Inline anchor-existence floor: document/section claims inside unbold
        // inline payloads are verified to exist (kinds always gate — never in
        // LEGACY_INLINE_EXEMPT_KINDS). Independent of gateTasksBlockCites, so it
        // runs even when the gate threw; its own failure is fail-closed too.
        try {
          for (const finding of runInlineAnchorFloor(section, { repoRoot })) {
            pushCite(finding.kind, `${unitPrefix} [${finding.kind}] ${finding.evidence}`);
          }
        } catch (err) {
          // Same reasoning as the gateTasksBlockCites catch above: the floor
          // failing to RUN is structural, so it gates unconditionally — and it
          // costs the plan its swept status for the same reason.
          const reason = String(err?.message ?? err).slice(0, 160);
          anomalies.push(`${unitPrefix} [cite-check-threw] inline anchor floor: ${reason}`);
          citeScreenFailure ??= `inline anchor floor threw on ${unitPrefix}: ${reason}`;
        }
        // Invariant-reference resolution: every `Verifies invariant:` id that
        // names an owning plan is resolved against that plan's declared set, in
        // BOTH marker channels. Position-independent like the cite screens, so
        // it runs on complements too. Fail-closed on the same terms as above.
        try {
          const invariants = runInvariantReferences(section, { repoRoot, cache: invariantCache });
          for (const finding of invariants.findings) {
            pushCite(finding.kind, `${unitPrefix} [${finding.kind}] ${finding.evidence}`);
          }
          for (const key of ["resolved", "noneArm", "parentResolved"]) {
            invariantBold[key] += invariants.bold[key];
            invariantLegacy[key] += invariants.legacy[key];
          }
          invariantFencedYamlRefs += invariants.fencedYamlRefs;
        } catch (err) {
          const reason = String(err?.message ?? err).slice(0, 160);
          anomalies.push(`${unitPrefix} [cite-check-threw] invariant resolution: ${reason}`);
          citeScreenFailure ??= `invariant resolution threw on ${unitPrefix}: ${reason}`;
        }
      }
      // The must-not-be-zero denominator for this screen, published only for
      // markers a complement screen actually judged. If complement construction
      // ever regresses to a no-op, every plan's line disappears from this list
      // while the plans keep their out-of-phase markers — so the screen going
      // dark is visible as an absence of output, not as a clean verdict. Without
      // it, a broken complement path and a corpus with no out-of-phase markers
      // print identically.
      if (complementMarkersScreened > 0) {
        complementMarkerPlans.push({
          name,
          complement: complementMarkersScreened,
          total: totalMarkers,
          units: complementUnitsScreened,
        });
      }
      // Markers inside a complement whose screen threw. Disclosed on its own line
      // rather than folded into the entry above, so the report never counts an
      // unrun screen toward the coverage it claims. `anomalies` already carries
      // the [cite-check-threw] for each such unit and the plan is marked uncovered
      // below; this is the marker-level accounting those two do not provide.
      if (complementMarkersUnjudged > 0) {
        unjudgedComplementPlans.push({
          name,
          unjudged: complementMarkersUnjudged,
          units: complementUnitsUnjudged,
        });
      }
      // THE uncovered-vs-markerless decision — one point, so a plan can never
      // land in both lists. Precedence is unchanged from when the residual
      // marked directly: it ran before the unit loop, so its reason won the
      // markUncovered dedupe. Both reasons still reach the reader regardless —
      // each pushed its own anomaly line — so this only picks the label shown
      // beside the plan in the uncovered list.
      if (partitionHole !== null || citeScreenFailure !== null) {
        // A screen that threw judged nothing, so this plan is NOT swept.
        // Without this the coverage line still counted it (`surveyedPlanCount`
        // subtracts only `uncoveredPlans`), `markerlessPlans` labelled the unrun
        // screen a vacuous pass, and — worst — the stale-exemption ratchet below
        // saw zero cite findings for an exempt plan and advised deleting a live
        // exemption on evidence that was never gathered. That last guard already
        // existed for the OUTER catch via `uncoveredPlanNames`; the per-unit
        // catches walked straight past it (Codex P2, PR #260 round 2).
        markUncovered(name, partitionHole ?? citeScreenFailure);
      } else if (surveyUnits.length > 0 && !planHasAnyCiteMarker) {
        markerlessPlans.push(name);
      }
      reportLines.push(
        allPhaseLabels.length === 0
          ? `${name}: 0 phase(s) — whole-document cite sweep`
          : `${name}: ${allPhaseLabels.length} phase(s) — ${phaseSummaries.join(" ")}`,
      );
    } catch (err) {
      const reason = String(err?.message ?? err).slice(0, 160);
      markUncovered(name, reason);
      // Gates through `anomalies` (unconditional), not citeAnomalies: a plan the
      // survey could not read or walk is a structural failure of the screen
      // itself, so it must not wait for --enforce-cites to be armed.
      anomalies.push(`${name} [survey-uncovered] plan could not be surveyed: ${reason}`);
    }
  }
  // Self-deleting ratchet + visible-debt summary, scoped to exempt plans PRESENT in
  // this corpus. A fixture repoRoot that lacks them is not a re-authoring signal
  // (skip it), and a renamed/removed plan simply un-exempts its new filename, which
  // then gates normally and surfaces the rename that way. An exempt plan still
  // present but emitting NO cite anomaly has been re-authored clean — push a
  // [stale-exemption] finding into the GATED citeAnomalies channel so it blocks
  // under --enforce-cites (warn-only under plain --survey) until the entry is
  // deleted. This is what keeps the exemption list from outliving its debt.
  const exemptFiles = [];
  // A plan the survey could not read or walk emits NO cite anomalies, so it
  // reaches the zero-count branch looking exactly like a re-authored one. Acting
  // on that would tell the author to delete an exemption on evidence that was
  // never gathered — dropping real debt coverage because the scan failed. Such a
  // plan already gates through the unconditional `[survey-uncovered]` anomaly,
  // so skipping it here loses nothing.
  // The entry still gets PUSHED — `exemptFiles.length` is the dead-entry
  // detector (a renamed or removed exempt plan drops it below the list length),
  // so suppressing the row would conflate "no longer in the corpus" with "could
  // not be read". Only the verdict is withheld.
  const uncoveredPlanNames = new Set(uncoveredPlans.map(({ name }) => name));
  for (const relPath of LEGACY_INLINE_CITE_EXEMPT) {
    const base = relPath.slice("docs/plans/".length);
    if (!planFileNames.includes(base)) continue;
    const uncovered = uncoveredPlanNames.has(base);
    const count = exemptAnomalyCount.get(base) ?? 0;
    exemptFiles.push({ base, count, uncovered });
    if (count === 0 && !uncovered) {
      citeAnomalies.push(
        `${base} [stale-exemption] exempt plan scans clean — re-authored; remove it from LEGACY_INLINE_CITE_EXEMPT`,
      );
    }
  }
  return {
    planCount: planFileNames.length,
    surveyedPlanCount: planFileNames.length - uncoveredPlans.length,
    phaseCount,
    distribution,
    reportLines,
    notices,
    anomalies,
    citeAnomalies,
    exemptCiteAnomalies,
    exemptFiles,
    fallbackPlans,
    unsweptMarkerPlans,
    complementMarkerPlans,
    unjudgedComplementPlans,
    markerlessPlans,
    uncoveredPlans,
    invariantBold,
    invariantLegacy,
    invariantFencedYamlRefs,
  };
}

export function formatSurvey(survey, { enforceCites = false } = {}) {
  const lines = [...survey.reportLines];
  lines.push(
    `distribution: L=${survey.distribution.L} M=${survey.distribution.M} S=${survey.distribution.S} ` +
      `across ${survey.phaseCount} phase(s) in ${survey.planCount} plan(s)`,
  );
  // Coverage is a FIRST-CLASS number, printed on every run and ahead of every
  // verdict line. `cite anomalies: none` means "checked and clean" only if the
  // survey reached every plan, so the reader gets the denominator, the plans
  // that needed the whole-document fallback, the ones that passed vacuously for
  // want of any cite marker, and the residual it could not reach at all.
  const fallbackPlans = survey.fallbackPlans ?? [];
  const markerlessPlans = survey.markerlessPlans ?? [];
  const uncoveredPlans = survey.uncoveredPlans ?? [];
  // `?? 0`, never `?? survey.planCount`: a survey object missing the field must
  // read as NO coverage, not FULL coverage. This is the one line whose whole
  // job is to avoid overstating what was checked, so its fallback has to fail
  // in the safe direction.
  lines.push(
    `coverage: ${survey.surveyedPlanCount ?? 0}/${survey.planCount} plan(s) cite-swept, ` +
      `${uncoveredPlans.length} uncovered`,
  );
  // The complement path's DENOMINATOR — the one count on this screen that must
  // not be zero while the corpus holds out-of-phase markers. A finding count of
  // zero is ambiguous between "clean" and "never ran"; this number is not. If
  // complement construction regresses to a no-op, this block stops printing
  // while the plans keep their markers, so the screen going dark shows up as
  // missing output instead of as a clean verdict.
  const complementMarkerPlans = survey.complementMarkerPlans ?? [];
  if (complementMarkerPlans.length) {
    const totalComplement = complementMarkerPlans.reduce((sum, plan) => sum + plan.complement, 0);
    lines.push(
      `  Gate-4 markers OUTSIDE every \`### Phase N\` section — screened via the complement path ` +
        `(${complementMarkerPlans.length} plan(s), ${totalComplement} marker(s)):`,
    );
    for (const { name, complement, total, units } of complementMarkerPlans) {
      lines.push(
        `    - ${name}: ${complement} of ${total} marker(s) in ${units} complement unit(s)`,
      );
    }
  }
  // The counter-line to the denominator above: complement markers whose screen
  // THREW. Printed adjacent to it so the two are read together — the block above
  // claims markers were screened, and this one names the markers for which that
  // claim does not hold. Never folded into the same numbers; a screen that failed
  // to run is not coverage.
  const unjudgedComplementPlans = survey.unjudgedComplementPlans ?? [];
  if (unjudgedComplementPlans.length) {
    const totalUnjudged = unjudgedComplementPlans.reduce((sum, plan) => sum + plan.unjudged, 0);
    lines.push(
      `  Gate-4 markers in complement units whose cite screen THREW — NOT screened ` +
        `(${unjudgedComplementPlans.length} plan(s), ${totalUnjudged} marker(s)):`,
    );
    for (const { name, unjudged, units } of unjudgedComplementPlans) {
      lines.push(`    - ${name}: ${unjudged} marker(s) in ${units} failed complement unit(s)`);
    }
  }
  // Invariant-reference resolution: one line of work done, two of debt.
  //
  // `?? 0` for the same reason the coverage line uses it — a survey object
  // missing these fields must read as NOTHING checked, never as everything
  // checked. This block is printed UNCONDITIONALLY, including at zero: the
  // resolved count going to zero is precisely the signal that the screen has
  // stopped running, and a block that disappears when it regresses would make
  // "broken" and "clean" print identically.
  //
  // Every line NAMES ITS OWN POPULATION rather than relying on position, and
  // the two channels are never summed: a combined total would let the legacy
  // channel go to zero — by retirement or by regression — without the printed
  // number moving enough to notice which of the two happened.
  const boldTally = survey.invariantBold ?? {};
  const legacyTally = survey.invariantLegacy ?? {};
  lines.push(
    `invariant references: ${boldTally.resolved ?? 0} resolved (bold \`**Verifies invariant:**\` markers) ` +
      `against the declared \`## Invariants\` set of the plan each id names`,
  );
  lines.push(
    `  ${legacyTally.resolved ?? 0} resolved (legacy compact-inline \`Verifies invariant:\` markers) — separate channel, never summed with the bold count`,
  );
  // Facet roll-ups resolved the PARENT only. `I-008-7c` proves `I-008-7` is
  // declared; nothing anywhere declares the `c`, so the sub-clause itself is
  // unverifiable by construction. Printed as its own number for the same reason
  // the `none` arm is: it is a weaker claim wearing the same word.
  //
  // Split per channel rather than summed, even though the roll-up itself is
  // channel-agnostic: these are sub-populations OF the two totals above, and a
  // combined figure here would be the one number a reader could mistake for a
  // cross-channel total. Same form as the `none` arm line below.
  lines.push(
    `  of which ${boldTally.parentResolved ?? 0} bold + ${legacyTally.parentResolved ?? 0} legacy facet reference(s) resolved to a declared PARENT only — the sub-clause letter is declared nowhere and is not verified`,
  );
  // The `none` arm is ACCEPTED, never verified. Plan-003:517/:525 show the
  // honest use (`none (I1 is an AC-coverage test)`), but nothing distinguishes
  // that from a task that does verify an invariant and writes `none` anyway —
  // so the size of the accepted-unverified population is printed rather than
  // implied. Visible debt, not silent acceptance.
  lines.push(
    `  ${boldTally.noneArm ?? 0} bold + ${legacyTally.noneArm ?? 0} legacy marker(s) accepted on the \`none\` arm — asserted, not verified`,
  );
  // Second reference channel, deliberately unscreened: `verifies_invariant:`
  // inside fenced task-DAG / manifest YAML, which maskNonContentLines hides
  // from the bold extractor by design. Counted so that "N resolved" is never
  // read as "every reference in the corpus".
  lines.push(
    `  ${survey.invariantFencedYamlRefs ?? 0} reference(s) in fenced \`verifies_invariant:\` YAML — not screened (masked as fenced content)`,
  );
  const unsweptMarkerPlans = survey.unsweptMarkerPlans ?? [];
  if (unsweptMarkerPlans.length) {
    // Printed with the coverage block for readability, but this list is NOT a
    // soft disclosure: every entry also carries a [markers-unswept] anomaly and
    // costs its plan the swept status. Phase spans and their complement partition
    // the source and markers are bucketed by offset against a single masked copy,
    // so a non-empty list is a genuine hole — not the masking disagreement that
    // once made this residual too noisy to gate on (Codex P1, PR #262 round 3).
    const totalUnswept = unsweptMarkerPlans.reduce((sum, plan) => sum + plan.unswept, 0);
    lines.push(
      `  Gate-4 markers in NEITHER a phase section nor its complement — unscreened ` +
        `(${unsweptMarkerPlans.length} plan(s), ${totalUnswept} marker(s)):`,
    );
    for (const { name, unswept, total } of unsweptMarkerPlans) {
      lines.push(`    - ${name}: ${unswept} of ${total} bold marker(s) reached by no survey unit`);
    }
  }
  if (fallbackPlans.length) {
    lines.push(`  whole-document fallback (${fallbackPlans.length}): ${fallbackPlans.join(", ")}`);
  }
  if (markerlessPlans.length) {
    lines.push(
      `  swept but no cite markers to verify — vacuous pass (${markerlessPlans.length}): ${markerlessPlans.join(", ")}`,
    );
  }
  if (uncoveredPlans.length) {
    lines.push(`  uncovered (${uncoveredPlans.length}) — gated via anomalies:`);
    for (const { name, reason } of uncoveredPlans) lines.push(`    - ${name}: ${reason}`);
  }
  if (survey.notices.length) {
    lines.push(`notices (${survey.notices.length}):`);
    for (const notice of survey.notices) lines.push(`  - ${notice}`);
  }
  if (survey.anomalies.length) {
    lines.push(`anomalies (${survey.anomalies.length}):`);
    for (const anomaly of survey.anomalies) lines.push(`  - ${anomaly}`);
  } else {
    lines.push("anomalies: none");
  }
  // Cite anomalies report on their own line group, loudly but separately from
  // the two-sided `anomalies` — they are warn-only under plain `--survey`.
  const citeAnomalies = survey.citeAnomalies ?? [];
  if (citeAnomalies.length) {
    const tag = enforceCites ? "ENFORCED — folds into exit" : "warn-only; arm with --enforce-cites";
    lines.push(`cite anomalies (${citeAnomalies.length}) [${tag}]:`);
    for (const anomaly of citeAnomalies) lines.push(`  - ${anomaly}`);
  } else {
    lines.push("cite anomalies: none");
  }
  // Legacy-inline exemptions: always PRINTED (visible debt), never folded into the
  // --enforce-cites exit. A present-but-clean-scanning exemption rides the
  // citeAnomalies group above as a [stale-exemption] finding, so it DOES gate. An
  // absent exempt path is skipped upstream (a rename un-exempts the new filename,
  // which then gates on its own), so it neither prints here nor rides that channel.
  const exemptFiles = survey.exemptFiles ?? [];
  if (exemptFiles.length) {
    const suppressed = (survey.exemptCiteAnomalies ?? []).length;
    lines.push(
      `cite-exempt (legacy-inline, ${exemptFiles.length} plan(s), ${suppressed} anomaly(ies) suppressed):`,
    );
    for (const { base, count, uncovered } of exemptFiles) {
      // A zero count means "scanned and found nothing" ONLY when the plan was
      // actually scanned. For an uncovered plan it means "never measured", and
      // printing the ratchet note there would recommend deleting an exemption
      // on evidence that does not exist.
      const note = uncovered
        ? "not scanned (see uncovered) — exemption retained"
        : count === 0
          ? "clean — stale entry (ratcheted)"
          : `${count} anomaly(ies) suppressed`;
      lines.push(`  - ${base}: ${note}`);
    }
  }
  return lines.join("\n");
}

// ---------- orchestration ----------

/**
 * Gate 4's unresolved half on the DISPATCH path.
 *
 * `gateTasksBlockCites` verifies every anchor it parses, and it accepts every
 * `plan-local-id` on the stated grounds that a plan-local id has no external
 * document to verify — true for `C5` / `P3`, false for `I-024-4`, which names
 * Plan-024 in its own bytes. So a phase declaring `**Verifies invariant:**
 * I-999-1` cleared dispatch preflight while the armed survey reported the same
 * reference as a defect: two screens over one corpus disagreeing about whether a
 * reference resolves, with the LOOSER one guarding the thing that actually ships.
 *
 * Same screen, same classification, same fail-closed posture as the survey path —
 * `verifyInvariantReferences` is called once per phase section and covers BOTH
 * marker channels (bold `**Verifies invariant:**` and the compact-inline form),
 * because wiring only the channel `extractCiteAnchors` already reads would leave
 * the legacy channel unscreened on dispatch exactly as it was on the survey.
 *
 * Runs for substrate-exempt phases too, unlike Gate 4 itself. The exemption
 * exists because criterion (3) phases carry no Spec AC coverage and Gate 4's
 * marker floor would halt them by design; this screen has no floor — a phase with
 * no invariant references produces no findings — so running it costs a legitimate
 * substrate phase nothing and denies a bad reference one place to hide.
 *
 * The COUNTS are deliberately dropped. They are census output: their consumer is
 * the survey report, where a zero tells "clean" from "never ran" across the whole
 * corpus. A per-phase tally answers no question dispatch asks, and printing one
 * here would put a second, differently-scoped census into circulation.
 */
function gatePhaseInvariantReferences(phaseSection, planNumber, phaseNumber, opts = {}) {
  let findings;
  try {
    findings = verifyInvariantReferences(phaseSection, {
      repoRoot: opts.repoRoot ?? REPO_ROOT,
      // One cache per RUN, threaded from runPreflight: the structural
      // report-once dedupe lives on the cache entry, so a fresh cache per phase
      // would re-read every owning plan and re-report one unreadable
      // `## Invariants` block once per phase of the walk.
      cache: opts.invariantCache ?? new Map(),
    }).findings;
  } catch (err) {
    // A screen that could not RUN judged nothing. Fail closed, in the same idiom
    // as the survey's per-unit catch.
    return {
      ok: false,
      halt: [
        "## Preflight halt: invariant-reference resolution failed to run",
        "",
        `Plan-${planNumber} Phase ${phaseNumber}: ${String(err?.message ?? err).slice(0, 240)}`,
        "",
        "The screen throwing is structural — it is not evidence the phase is clean.",
      ].join("\n"),
    };
  }
  if (findings.length === 0) return { ok: true };
  const lines = [
    "## Preflight halt: Gate 4 invariant-reference resolution failed",
    "",
    `Plan-${planNumber} Phase ${phaseNumber} has ${findings.length} unresolved invariant reference(s).`,
    "Every `Verifies invariant:` id that names an owning plan (`I-024-4` names Plan-024)",
    "is resolved against that plan's declared `## Invariants` set.",
    "",
  ];
  for (const finding of findings) lines.push(`- [${finding.kind}] ${finding.evidence}`);
  lines.push("");
  lines.push("Authoring contract: docs/operations/plan-implementation-readiness-audit-runbook.md");
  return { ok: false, halt: lines.join("\n") };
}

function _checkPhase(planSource, planNumber, phase, planFile, opts) {
  const ship = gatePhaseUnshipped(planSource, planNumber, phase);
  if (!ship.ok) return { eligible: false, reason: ship.kind, halt: ship.halt };
  const sec = extractPhaseSection(planSource, phase.number);
  if (!sec)
    return {
      eligible: false,
      reason: "no-section",
      halt: `cannot extract phase ${phase.number} section`,
    };
  // Per-phase audit gate runs before Gate 4 + Gate 5 — substrate-exempt
  // phases also use this to admit themselves before Gate 4 is skipped.
  const gPhase = gatePhaseAuditCheckbox(planSource, sec, planFile, phase.number);
  if (!gPhase.ok) return { eligible: false, reason: "audit", halt: gPhase.halt };
  // Size class is computed for every phase — including substrate-exempt ones,
  // which skip Gate 4 but still drive the SKILL.md ceremony map off the class.
  const sizeClass = classifyPhaseSize(extractDeclaredTaskIds(sec), extractDeclaredFilePaths(sec));
  // Gate 4 (Tasks-block G4 cites) is skipped for phases declaring
  // audit_status: substrate_exempt. By criterion (3) those phases ship pure
  // pre-behavior plumbing with zero Spec AC coverage — Gate 4's `Spec
  // coverage` substring requirement would halt them by design. The
  // substrate_exempt YAML is the explicit opt-out; the Gate 5 resolver
  // verifies the criterion (3) sentinel + Tasks-block-bracket-conflict
  // check in lieu of Gate 4.
  const entries = parsePreconditionsBlock(sec) ?? [];
  const isSubstrateExempt = entries.some(
    (e) => e.type === "audit_status" && e.status === "substrate_exempt",
  );
  let g4 = null;
  if (!isSubstrateExempt) {
    g4 = gateTasksBlockCites(sec, planNumber, phase.number, { ...opts, sizeClass });
    if (!g4.ok) return { eligible: false, reason: "audit", halt: g4.halt };
  }
  const g4Invariants = gatePhaseInvariantReferences(sec, planNumber, phase.number, opts);
  if (!g4Invariants.ok)
    return {
      eligible: false,
      reason: "audit",
      halt: g4Invariants.halt,
      // Demoted G4 warnings ride every halt path, not just the pass path — the
      // never-silent contract (Codex, PR #190) covers new halts too.
      warnings: g4?.warnings ?? [],
    };
  const g5 = gatePreconditions(sec, planFile, phase.number, {
    ...opts,
    phaseSection: sec,
    phaseNumber: phase.number,
    planSource,
  });
  if (!g5.ok)
    return {
      eligible: false,
      reason: "preconditions",
      halt: g5.halt,
      warnings: g4?.warnings ?? [],
    };
  // Demoted G4 findings must ride the PASS path (delta D-14) — otherwise S/M
  // grammar rot accumulates invisibly behind the demotion.
  return { eligible: true, sizeClass, warnings: g4?.warnings ?? [] };
}

export function runPreflight(
  planFile,
  phaseArg,
  {
    repoRoot = REPO_ROOT,
    skillMd = SKILL_MD,
    checkFreshness = false,
    checkStatusPromotion = false,
  } = {},
) {
  const g1 = gateProjectLocality({ repoRoot, skillMd });
  if (!g1.ok) return { exit: 1, stdout: g1.halt };

  let planSource;
  try {
    planSource = readFileSync(planFile, "utf8");
  } catch (e) {
    return { exit: 2, stderr: `read plan ${planFile}: ${e.message}` };
  }

  const g2 = gateAuditCheckbox(planSource, planFile);
  if (!g2.ok) return { exit: 1, stdout: g2.halt };

  // Gate 7 sits with the plan-level gates, before the phase walk: promotion
  // is a plan property, and halting here keeps the CLI status check
  // network-free (it fires before Gate 6's gh calls). Same CLI-on /
  // programmatic-opt-in split as checkFreshness.
  if (checkStatusPromotion) {
    const g7 = gateStatusPromotion(planSource, planFile);
    if (!g7.ok) return { exit: 1, stdout: g7.halt };
    const g7boxes = gatePlanPreconditionBoxes(planSource, planFile);
    if (!g7boxes.ok) return { exit: 1, stdout: g7boxes.halt };
  }

  const planNumber = extractPlanNumber(planFile);
  if (planNumber === null) return { exit: 2, stderr: `bad plan filename: ${basename(planFile)}` };

  const phases = walkPhases(planSource);
  if (phases.length === 0)
    return {
      exit: 2,
      stderr: `no \`### Phase N\` headers found in ${planFile} (accepted separators: \`—\`, \`:\`, \`-\`)`,
    };

  // Gate 6 — manifest freshness. CLI runs default it ON (--allow-stale-manifest
  // is the explicit escape); programmatic/test callers opt in via
  // checkFreshness so fixture-driven suites stay network-free. Runs before the
  // phase walk because a stale manifest corrupts Gate 3's phase selection.
  if (checkFreshness) {
    const g6 = gateManifestFreshness(planSource, planNumber);
    if (!g6.ok) return { exit: 1, stdout: g6.halt };
  }

  // One invariant-declaration cache per RUN, so the auto-walk parses each owning
  // plan's `## Invariants` block once and reports a structural failure on it once
  // — the same one-cache-per-run shape surveyCorpus uses.
  const opts = { repoRoot, invariantCache: new Map() };
  if (phaseArg !== undefined && phaseArg !== null) {
    const target = phases.find((p) => p.number === phaseArg);
    if (!target)
      return { exit: 1, stdout: `## Preflight halt: phase ${phaseArg} not found in ${planFile}` };
    const r = _checkPhase(planSource, planNumber, target, planFile, opts);
    // Halt paths carry demoted warnings too — explicit-phase overrides are a
    // normal recovery path, and the never-silent contract must survive them
    // (Codex, PR #190: precondition halt was hiding the phase's cite drift).
    if (!r.eligible) return { exit: 1, stdout: r.halt, warnings: r.warnings ?? [] };
    return { exit: 0, stdout: String(target.number), sizeClass: r.sizeClass, warnings: r.warnings };
  }

  const skipped = [];
  // Demoted G4 grammar warnings from phases the walk SKIPS (e.g. an S phase
  // whose only hard failure is an unmet precondition) must still surface on
  // the eventual success return — the never-silent contract covers skipped
  // phases too, or cite rot hides behind the skip.
  const walkWarnings = [];
  for (const p of phases) {
    const r = _checkPhase(planSource, planNumber, p, planFile, opts);
    if (r.eligible)
      return {
        exit: 0,
        stdout: String(p.number),
        sizeClass: r.sizeClass,
        warnings: [...walkWarnings, ...(r.warnings ?? [])],
      };
    // `fully_shipped` is the only legitimate silent-skip — every other Gate 3
    // failure must surface, including the round-7/8 strict halts. Pre-round-9
    // _checkPhase collapsed all `gatePhaseUnshipped` failures to `reason:
    // "shipped"`, so manifest_unparseable / manifest_invalid_entries got
    // silenced in auto-walk mode (Codex P1 finding on PR #35 round 9). The
    // explicit list — not a default — guarantees future strict-halt kinds
    // also surface unless they're explicitly added as silent-skip.
    //
    // `audit` is in the strict-halt set: an upstream phase failing Gate 2
    // (per-phase audit checkbox) or Gate 4 (Tasks-block G4 cites) signals an
    // author defect that author-defect clustering says will almost certainly
    // affect later phases as well, and the previous auto-walk semantics
    // could resolve to a later phase that passed its own gates while the
    // earlier audit-failed phase went unsurfaced. Authors who need to
    // execute a downstream phase ahead of an audit-failing earlier one can
    // pass the explicit `<phase-number>` argument to override.
    if (r.reason === "fully_shipped") continue;
    if (
      r.reason === "manifest_unparseable" ||
      r.reason === "manifest_invalid_entries" ||
      r.reason === "audit"
    ) {
      return { exit: 1, stdout: r.halt, warnings: [...walkWarnings, ...(r.warnings ?? [])] };
    }
    // no-section / preconditions — per-phase issues, try next phase.
    walkWarnings.push(...(r.warnings ?? []));
    // Full halt body, not just the header line: the per-phase failures are the
    // actionable content (which yaml entry failed, which boxes are unchecked
    // or orphaned, the remediation text), and this aggregate is the ONLY halt
    // an auto-mode run prints when no phase is eligible — truncating to
    // `r.halt.split("\n")[0]` rendered every Gate 5 detail unreachable there
    // (the header line is generic per reason, so it added nothing).
    const haltLines = r.halt.split("\n");
    const headerless = haltLines[0].startsWith("## Preflight halt:")
      ? haltLines.slice(1).join("\n").trim()
      : r.halt.trim();
    const body = headerless.length > 0 ? headerless : haltLines[0];
    const indented = body
      .split("\n")
      .map((bodyLine) => (bodyLine.length > 0 ? `      ${bodyLine}` : bodyLine))
      .join("\n");
    skipped.push(`Phase ${p.number} (${r.reason}):\n${indented}`);
  }
  const reasonsText = skipped.length
    ? `\n\nNon-eligible phases:\n${skipped.map((s) => `  - ${s}`).join("\n\n")}`
    : "";
  return {
    exit: 1,
    stdout: `## Preflight halt: no eligible un-shipped phase in ${planFile}${reasonsText}`,
    warnings: walkWarnings,
  };
}

// ---------- CLI ----------

async function main() {
  const args = process.argv.slice(2);
  const knownFlags = new Set([
    "--allow-stale-manifest",
    "--allow-unpromoted",
    "--help",
    "-h",
    "--survey",
    "--enforce-cites",
  ]);
  const unknownFlags = args.filter((a) => a.startsWith("-") && !knownFlags.has(a));
  if (unknownFlags.length > 0) {
    process.stderr.write(`unknown flag(s): ${unknownFlags.join(", ")}\n`);
    process.exit(2);
  }
  if (args.includes("--survey")) {
    // Corpus-wide extractor screen; no plan file, no gates, no network.
    // Exit 1 on any two-sided anomaly so authoring/refactor workflows can
    // gate on it. Strictly solo: a mixed invocation like
    // `preflight.mjs <plan> <phase> --survey` must NOT silently take the
    // survey path — the caller asked for a gated phase check, and exiting
    // on survey cleanliness alone would green-light an unvetted phase
    // (Codex P2, PR #192). Only `--enforce-cites` may accompany `--survey`.
    // Contract: ../references/preflight-contract.md § Survey mode.
    const surveyExtra = args.filter((a) => a !== "--survey" && a !== "--enforce-cites");
    if (surveyExtra.length > 0) {
      process.stderr.write(
        "--survey runs alone — it takes no plan file, phase, or other flags (only --enforce-cites)\n",
      );
      process.exit(2);
    }
    const survey = surveyCorpus();
    const enforceCites = args.includes("--enforce-cites");
    process.stdout.write(formatSurvey(survey, { enforceCites }) + "\n");
    // Two-sided omission/phantom anomalies always gate. Gate-4 cite anomalies are
    // WARN-ONLY under plain `--survey` and gate under `--enforce-cites`.
    //
    // ARMED (2026-07-17): the docs-corpus CI step runs `--survey --enforce-cites`,
    // so citeAnomalies fold into the exit. The live corpus reaches 0 GATED cite
    // anomalies because the two compact-inline plans (Plan-008/023) divert
    // to the printed exemptCiteAnomalies channel via LEGACY_INLINE_CITE_EXEMPT —
    // their legacy-unbold / partial-marker debt stays visible but non-blocking, and
    // the stale-exemption ratchet fails the moment one is re-authored clean. To
    // retire an exemption: re-author the plan into expanded one-marker-per-line
    // cites, then delete its LEGACY_INLINE_CITE_EXEMPT entry (the ratchet enforces
    // the pairing). Real-corpus guards live in preflight-survey.test.mjs.
    const blockingCount =
      survey.anomalies.length + (enforceCites ? survey.citeAnomalies.length : 0);
    // exitCode + return, NOT process.exit(): stdout writes to a PIPE are async in
    // Node, and process.exit() discards whatever is still buffered. The survey
    // report exceeds the 64KiB-nominal/8KiB-observed pipe buffer, so exiting hard
    // truncated it mid-line under CI and the `cite-exempt` visible-debt block —
    // whose entire purpose is "never a silent skip" — was cut off exactly when the
    // gate failed. Returning lets Node drain before it exits.
    process.exitCode = blockingCount > 0 ? 1 : 0;
    return;
  }
  const allowStaleManifest = args.includes("--allow-stale-manifest");
  const allowUnpromoted = args.includes("--allow-unpromoted");
  const positional = args.filter((a) => !a.startsWith("-"));
  if (positional.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stderr.write(
      "Usage: node preflight.mjs <plan-file> [phase-number] [--allow-stale-manifest] [--allow-unpromoted] | --survey [--enforce-cites]\n" +
        "See ../references/preflight-contract.md.\n",
    );
    process.exit(2);
  }
  const planFile = positional[0];
  const phaseArg = positional[1] !== undefined ? Number(positional[1]) : undefined;
  if (positional[1] !== undefined && (Number.isNaN(phaseArg) || !Number.isInteger(phaseArg))) {
    process.stderr.write(`bad phase argument: ${positional[1]}\n`);
    process.exit(2);
  }
  if (allowStaleManifest) {
    process.stderr.write(
      "preflight: Gate 6 (manifest freshness) SKIPPED via --allow-stale-manifest\n",
    );
  }
  if (allowUnpromoted) {
    process.stderr.write(
      "preflight: Gate 7 (status promotion + governance preconditions) SKIPPED via --allow-unpromoted\n",
    );
  }
  const result = runPreflight(planFile, phaseArg, {
    checkFreshness: !allowStaleManifest,
    checkStatusPromotion: !allowUnpromoted,
  });
  const warningLines = (result.warnings ?? []).map(
    (w) => `  - [${w.kind}] ${[w.taskId, w.field, w.message].filter(Boolean).join(" ")}`,
  );
  // Halt warnings fold INTO the stdout halt text: the orchestrator contract
  // surfaces stdout verbatim on non-zero exit, so stderr-only warnings would
  // vanish on the exact recovery paths they were added for (Codex, PR #190).
  if (result.stdout) {
    const haltWarningsBlock =
      result.exit !== 0 && warningLines.length
        ? `\n\nDemoted grammar warnings (non-blocking, carried by the halt):\n${warningLines.join("\n")}`
        : "";
    process.stdout.write(result.stdout + haltWarningsBlock + "\n");
  }
  // Line 2 of the success contract (delta D-5): the phase's size class drives
  // the ceremony map in SKILL.md § Size-Classed Ceremony.
  if (result.exit === 0 && result.sizeClass)
    process.stdout.write(`size-class: ${result.sizeClass}\n`);
  // Success path: demoted findings are non-blocking but NEVER silent — stderr
  // keeps the success stdout contract at exactly two lines while the author
  // still sees the drift.
  if (result.exit === 0 && warningLines.length) {
    process.stderr.write(
      `preflight: size-class ${result.sizeClass} demoted ${warningLines.length} grammar finding(s) to warnings:\n` +
        warningLines.join("\n") +
        "\n",
    );
  }
  if (result.stderr) process.stderr.write(result.stderr + "\n");
  // Same pipe-drain reason as the survey path above: a Gate-4 halt enumerates
  // every finding, and the orchestrator contract surfaces stdout verbatim on
  // non-zero exit — process.exit() would truncate the halt the caller must read.
  process.exitCode = result.exit;
}

/**
 * Direct-invocation guard — same form as `validate-review-response.mjs`
 * § isDirectlyInvoked and `tools/docs-corpus/bin/pre-commit-runner.ts`.
 *
 * The previous spelling compared `process.argv[1]` to `fileURLToPath(...)`
 * directly: encoding-correct, but not realpath-normalised, so an invocation
 * through a symlinked path (macOS `/tmp` -> `/private/tmp`, or a checkout under
 * a symlink) compared unequal and this gate silently no-opped with exit 0 —
 * a required CI check reporting clean over work it never did, which is the
 * exact failure class the rest of this file exists to close.
 */
function isDirectlyInvoked() {
  const invokedPath = process.argv[1];
  if (typeof invokedPath !== "string") return false;
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that will not resolve to a real file was not this module's entry
    // point, so `false` is the correct answer rather than a swallowed failure.
    return false;
  }
}

if (isDirectlyInvoked()) {
  main().catch((e) => {
    process.stderr.write(`internal error: ${e.message || String(e)}\n`);
    process.exit(2);
  });
}
