// Each pane kind's width rule: the width it opens at, the narrowest its own content reads at, and
// whether its own edge resizes it. Root-relative, so every figure follows the text size.

import type { BlockPaneKind } from "#renderer/routing/panes/kinds.js";
import {
  AGENTS_PANE_WIDTH_REM,
  INSPECTOR_WIDTH_REM,
  PREVIEW_PANE_FLOOR_REM,
  PREVIEW_PANE_WIDTH_REM,
  REVIEW_PANE_FLOOR_REM,
  REVIEW_PANE_WIDTH_REM,
  TERMINAL_PANE_FLOOR_REM,
  TERMINAL_PANE_WIDTH_REM,
} from "#renderer/styles/palette.js";

/** One pane kind's width rule, in rem. */
export interface PaneWidthRule {
  /** The width the pane opens at and an edge's reset returns it to. */
  readonly widthRem: number;
  /** The narrowest the pane is drawn at; the row scrolls sideways before it goes under. */
  readonly floorRem: number;
  /** Whether the pane carries its own edge and the full-width toggle. */
  readonly isResizable: boolean;
}

const REVIEW_WIDTH_RULE: PaneWidthRule = {
  widthRem: REVIEW_PANE_WIDTH_REM,
  floorRem: REVIEW_PANE_FLOOR_REM,
  isResizable: true,
};

/**
 * Every block pane kind's width rule. The inspector and the agents pane are as wide as their
 * widest row reads and are not resizable, so their width is their floor. The workflow builder
 * reads a diff-wide canvas, so it takes Review's rule.
 */
export const PANE_WIDTH_RULE_BY_KIND: Readonly<Record<BlockPaneKind, PaneWidthRule>> = {
  inspector: { widthRem: INSPECTOR_WIDTH_REM, floorRem: INSPECTOR_WIDTH_REM, isResizable: false },
  diff: REVIEW_WIDTH_RULE,
  "workflow-builder": REVIEW_WIDTH_RULE,
  browser: {
    widthRem: PREVIEW_PANE_WIDTH_REM,
    floorRem: PREVIEW_PANE_FLOOR_REM,
    isResizable: true,
  },
  terminal: {
    widthRem: TERMINAL_PANE_WIDTH_REM,
    floorRem: TERMINAL_PANE_FLOOR_REM,
    isResizable: true,
  },
  agents: { widthRem: AGENTS_PANE_WIDTH_REM, floorRem: AGENTS_PANE_WIDTH_REM, isResizable: false },
};

/**
 * Each pane kind's opening width in CSS px at a root font size of `rootFontSizePx`, keyed by the
 * kind: the widths a pane's own window opens at.
 */
export function paneWindowWidthsPx(rootFontSizePx: number): Readonly<Record<string, number>> {
  const widths: Record<string, number> = {};
  for (const [kind, rule] of Object.entries(PANE_WIDTH_RULE_BY_KIND)) {
    widths[kind] = rule.widthRem * rootFontSizePx;
  }
  return widths;
}
