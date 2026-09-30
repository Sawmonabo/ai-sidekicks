// Which face draws each glyph. `styles/glyphs.ts` owns the names and geometry; this module maps
// names to faces and sits in `components/` because a face is a React component.
//
// A name takes the Tabler face when Tabler draws the same picture from the set's parts. It stays
// a signature face when it is reserved as ours (users, runs, provenance kinds), when Tabler
// rounds a corner with an explicit radius instead of the stroke join, or when Tabler's icon of
// that name is a different picture. Both collections compile through the one normalization in
// `vitest/icon-compilation.ts`; a signature face is an SVG under `assets/icons/signature/` plus
// a row here.

import type { ComponentType, SVGProps } from "react";

import type { GlyphName } from "@renderer/styles/glyphs.js";

// --- The top-level destinations.
// Rail destination; Tabler stacks the same plate and two chevrons out of the same lines.
import SessionsFace from "~icons/tabler/stack-2";
// Rail destination; sliders rather than the gear the set rejects, drawn as rules and handles.
import SettingsFace from "~icons/tabler/adjustments-horizontal";

// --- Entity and pane kinds — the breadcrumb's kind glyph.
// An agent, which is reserved as ours.
import AgentFace from "~icons/signature/agent";
// Runs are reserved as ours; Tabler's `activity` is near-identical, so the pair must match.
import RunFace from "~icons/signature/run";
// The shield is built from straight sides; Tabler's is a twelve-unit arc construction.
import ApprovalFace from "~icons/signature/approval";
// A provenance kind and a container; Tabler's file rounds its corners with an explicit radius.
import ArtifactFace from "~icons/signature/artifact";
// A workspace: a folder softened by the join, not Tabler's two-unit radius.
import WorkspaceFace from "~icons/signature/workspace";
// A provenance kind; Tabler's `git-branch` adds an arrow head.
import WorktreeFace from "~icons/signature/worktree";
// A provenance kind, and a container Tabler rounds with a two-unit radius rather than the join.
import RepoFace from "~icons/signature/repo";
// A picture of the pane it opens; Tabler's `timeline` is a line chart, `list` has no rail.
import TranscriptIcon from "~icons/signature/transcript";
// A container; Tabler rounds its frame with a two-unit radius rather than the join.
import TerminalFace from "~icons/signature/terminal";
// A container, for the reason `terminal` is one.
import PreviewIcon from "~icons/signature/preview";
// Two containers and a connector; Tabler's `sitemap` rounds every node with an explicit radius.
import WorkflowFace from "~icons/signature/workflow";
// A container with a split; Tabler's layout frames round corners with an explicit radius.
import InspectorFace from "~icons/signature/inspector";
// A provenance kind; Tabler's `git-compare` and `file-diff` are different pictures.
import DiffFace from "~icons/signature/diff";

// --- State marks.
// A circle and two hands, built from the set's own parts.
import ClockFace from "~icons/tabler/clock";
// A triangle closed by the join; Tabler's rounds each corner with an explicit arc.
import AlertFace from "~icons/signature/alert";
// One polyline; the borrowed one is the same three points.
import CheckFace from "~icons/tabler/check";
// A circle drawn as two half-arcs, which is the set's own construction.
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
// Two strokes; Tabler's `player-pause` is two rectangles rounded with an explicit radius.
import PauseFace from "~icons/signature/pause";
// One of the run-control triad, and the other two stay ours, so the three read from one hand.
import PlayFace from "~icons/signature/play";
// A square softened by the join; Tabler's `player-stop` rounds with a two-unit radius.
import StopFace from "~icons/signature/stop";
// A solid open ring with the head on its own start; Tabler's `rotate-2` dots half the ring.
import RewindFace from "~icons/signature/rewind";
// Two square-cornered rectangles; Tabler rounds both with an explicit radius.
import CopyFace from "~icons/signature/copy";
// Straight sides throughout; Tabler closes its eraser end with an arc.
import PencilFace from "~icons/signature/pencil";
// A container plus an arrow; Tabler rounds the frame with a radius rather than the join.
import ExternalFace from "~icons/signature/external";
// Three zero-length segments under round caps; Tabler draws three circles.
import MoreFace from "~icons/signature/more";
// Two lines.
import PlusFace from "~icons/tabler/plus";

/** One compiled face: an `<svg>` component that forwards every prop to its root. */
export type GlyphIcon = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * The face every glyph name is drawn by. Total by type: a name without a face is a compile
 * error, and a face without a name is an unused import.
 */
export const GLYPH_ICONS: Readonly<Record<GlyphName, GlyphIcon>> = {
  sessions: SessionsFace,
  settings: SettingsFace,
  agent: AgentFace,
  run: RunFace,
  approval: ApprovalFace,
  artifact: ArtifactFace,
  workspace: WorkspaceFace,
  worktree: WorktreeFace,
  repo: RepoFace,
  transcript: TranscriptIcon,
  terminal: TerminalFace,
  browser: PreviewIcon,
  workflow: WorkflowFace,
  inspector: InspectorFace,
  diff: DiffFace,
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
