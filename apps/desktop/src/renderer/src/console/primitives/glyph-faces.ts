// Which face draws each glyph — one line per name, with the reason it is there.
//
// `tokens/glyphs.ts` owns the NAMES and the geometry every face is held to; this
// module owns the answer to "what is this name drawn by". It sits in
// `primitives/` rather than beside the names because a face is a React component
// and `tokens/` is below `primitives/` on the console DAG — and because the
// split is what makes the set's closedness checkable: {@link GLYPH_FACES} is a
// `Record<GlyphName, …>`, so a name added to `GLYPH_NAMES` with no row here
// fails the typecheck rather than rendering nothing at runtime.
//
// THE RULE THAT DECIDED EACH ROW, stated once so the rows can be one line each.
// `Spec-023 §Console Design (Meridian)` §Layout grammar reserves our own faces
// for participants, runs, and provenance kinds; `tokens/glyphs.ts` rule 2 fixes
// the vocabulary of parts the rest of the family is drawn from. So a name takes
// the Tabler face when Tabler publishes the same picture out of those parts, and
// stays signature when the governing text reserves it, when Tabler softens a
// corner with an explicit radius instead of with the stroke join, or when
// Tabler's icon of that name is a different picture. Eleven names are borrowed;
// twenty-five are ours.
//
// BOTH HALVES COMPILE THE SAME WAY. `~icons/signature/<name>` resolves against
// `glyph-faces/signature/<name>.svg` and `~icons/tabler/<name>` against the
// installed icon set, and both pass through the one normalization in
// `vitest/icon-compilation.ts` — so a signature face and a borrowed one arrive
// carrying the same stroke, the same caps and joins, and no fill. Adding a
// signature glyph is adding an SVG file and a row here; there is no path table
// to keep in step and no second place a weight can be set.

import type { ComponentType, SVGProps } from "react";

import type { GlyphName } from "../tokens/index.js";

// --- The top-level destinations and the session workspace.
// Rail destination; Tabler stacks the same plate and two chevrons out of the same lines.
import SessionsFace from "~icons/tabler/stack-2";
// A folder whose corners are the family's, not Tabler's two-unit radius (rule 2).
import WorkspaceFace from "~icons/signature/workspace";
// Rail destination; sliders rather than the gear the family rejects, drawn as rules and handles.
import SettingsFace from "~icons/tabler/adjustments-horizontal";

// --- Entity and pane kinds — the breadcrumb's kind glyph.
// A participant, which the governing text reserves; the hexagon reads against `member`'s circle only if both are ours.
import AgentFace from "~icons/signature/agent";
// Runs are reserved by the governing text, and Tabler's `activity` is near-identical — which is why the pairing must be from one hand.
import RunFace from "~icons/signature/run";
// The shield is built from straight sides; Tabler's is a twelve-unit arc construction.
import ApprovalFace from "~icons/signature/approval";
// A provenance kind, and a container: Tabler's file rounds its corners with an explicit radius (rule 2).
import ArtifactFace from "~icons/signature/artifact";
// A provenance kind; Tabler's `git-branch` adds an arrow head this family does not draw.
import WorktreeFace from "~icons/signature/worktree";
// A provenance kind, and a container Tabler rounds at two units (rule 2).
import RepoFace from "~icons/signature/repo";
// Two rules crossing two rules; there is no second way to draw a hash.
import ChannelFace from "~icons/tabler/hash";
// A picture of the surface it opens; Tabler's `timeline` is a line chart and its `list` has no rail.
import TimelineFace from "~icons/signature/timeline";
// A container; Tabler rounds its frame at two units (rule 2).
import TerminalFace from "~icons/signature/terminal";
// A container, for the reason `terminal` is one.
import BrowserFace from "~icons/signature/browser";
// Two containers and a connector; Tabler's `sitemap` rounds every node (rule 2).
import WorkflowFace from "~icons/signature/workflow";
// A container with a split; Tabler's layout frames round their corners (rule 2).
import InspectorFace from "~icons/signature/inspector";
// A provenance kind; Tabler's `git-compare` and `file-diff` are different pictures.
import DiffFace from "~icons/signature/diff";
// A participant, reserved by the governing text and paired with `agent`.
import MemberFace from "~icons/signature/member";
// Two rings and a centre dot; Tabler's `target` draws three rings, which is a different picture.
import GoalFace from "~icons/signature/goal";

// --- State marks.
// A circle and two hands, built from the parts rule 2 names.
import ClockFace from "~icons/tabler/clock";
// A triangle closed by the join; Tabler's rounds each corner with an explicit arc (rule 2).
import AlertFace from "~icons/signature/alert";
// One polyline; the borrowed one is the same three points.
import CheckFace from "~icons/tabler/check";
// A circle drawn as two half-arcs, which is rule 2's own construction.
import DotFace from "~icons/tabler/point";
// The compaction boundary's own mark; Tabler's `fold` is arrows over a dotted rule.
import FoldFace from "~icons/signature/fold";

// --- Control verbs and navigation.
// A ring and a tail, both plain.
import SearchFace from "~icons/tabler/search";
// Two crossing lines.
import CloseFace from "~icons/tabler/x";
// One polyline.
import ChevronRightFace from "~icons/tabler/chevron-right";
// One polyline.
import ChevronDownFace from "~icons/tabler/chevron-down";
// Two strokes; Tabler's `player-pause` is two rounded rectangles (rule 2).
import PauseFace from "~icons/signature/pause";
// One of the run-control triad, and the other two stay ours, so the three read from one hand.
import PlayFace from "~icons/signature/play";
// A square softened by the join; Tabler's `player-stop` rounds at two units (rule 2).
import StopFace from "~icons/signature/stop";
// A solid open ring with the head on its own start; Tabler's `rotate-2` dots half the ring.
import RewindFace from "~icons/signature/rewind";
// Two square-cornered rectangles; Tabler rounds both with an explicit radius (rule 2).
import CopyFace from "~icons/signature/copy";
// Straight sides throughout; Tabler closes its eraser end with an arc (rule 2).
import PencilFace from "~icons/signature/pencil";
// A container plus an arrow, and the frame is the rounded half of Tabler's (rule 2).
import ExternalFace from "~icons/signature/external";
// Three dots as zero-length segments under round caps, which is rule 2's construction; Tabler draws three circles.
import MoreFace from "~icons/signature/more";
// Two lines.
import PlusFace from "~icons/tabler/plus";

/** One compiled face: an `<svg>` that takes whatever props its caller sets. */
export type GlyphFace = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * The face every glyph name is drawn by.
 *
 * TOTAL BY TYPE, which is the whole reason the record is written out rather than
 * derived from a directory listing: `Record<GlyphName, GlyphFace>` makes a name
 * without a face a compile error, and a face without a name an unused import the
 * lint gate reports. A directory scan would answer both questions at runtime, in
 * a bundle, too late for either.
 */
export const GLYPH_FACES: Readonly<Record<GlyphName, GlyphFace>> = {
  sessions: SessionsFace,
  workspace: WorkspaceFace,
  settings: SettingsFace,
  agent: AgentFace,
  run: RunFace,
  approval: ApprovalFace,
  artifact: ArtifactFace,
  worktree: WorktreeFace,
  repo: RepoFace,
  channel: ChannelFace,
  timeline: TimelineFace,
  terminal: TerminalFace,
  browser: BrowserFace,
  workflow: WorkflowFace,
  inspector: InspectorFace,
  diff: DiffFace,
  member: MemberFace,
  goal: GoalFace,
  clock: ClockFace,
  alert: AlertFace,
  check: CheckFace,
  dot: DotFace,
  fold: FoldFace,
  search: SearchFace,
  close: CloseFace,
  "chevron-right": ChevronRightFace,
  "chevron-down": ChevronDownFace,
  pause: PauseFace,
  play: PlayFace,
  stop: StopFace,
  rewind: RewindFace,
  copy: CopyFace,
  pencil: PencilFace,
  external: ExternalFace,
  more: MoreFace,
  plus: PlusFace,
};
