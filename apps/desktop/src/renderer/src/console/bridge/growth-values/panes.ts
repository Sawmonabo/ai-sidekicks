// The pane surfaces' own values: what a browser pane reports, what a terminal pane
// streams, and how a pane says it could not open.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys — why a shape earns a name, what belongs in the
// signature table instead, and what belongs in a module of its own — and publishes
// the whole set. Import from the barrel; this file is the domain's own text.

export interface GrowthNavigationState {
  readonly url: string;
  readonly title: string;
  readonly isLoading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /**
   * How far through the load the view is, between 0 and 1, or `null` where it does
   * not report one.
   *
   * REQUIRED AND NULLABLE rather than optional, because the two spellings say
   * different things to a consumer: an absent member reads as "not answered yet" and
   * this is a producer that answered and has no fraction to give. The design's
   * determinate hairline is driven by the number; an engine that reports none gets
   * the indeterminate arm, and neither one is a fraction the renderer invented.
   */
  readonly loadProgress: number | null;
}

/**
 * One page a session owns, as the pane's tab strip and page picker read it.
 *
 * It earns a name here rather than sitting inline in the signature table because two
 * operations carry it — the page subscription streams a list of them, and the pane
 * attach answers with the one it attached — and because the surfaces that read it are
 * more than one: the strip, the picker, and each per-page control they draw.
 *
 * `label` is `null` rather than absent where no agent set one. The design's strip
 * carries "the page's label where the agent set one and its title otherwise", so the
 * absence is a value the renderer branches on, and an optional member would let a
 * producer omit it and a consumer read `undefined` as "not answered yet".
 *
 * `isSelected` and `isShown` are two facts and not one. A page can be pinned as the
 * pane's selected tab WITHOUT being shown — that separation is what makes an agent's
 * background page watchable without stealing the tab a person is reading.
 */
export interface GrowthBrowserPage {
  readonly pageId: string;
  readonly label: string | null;
  readonly title: string;
  readonly url: string;
  readonly host: string;
  readonly isLoading: boolean;
  readonly isSelected: boolean;
  readonly isShown: boolean;
}

/**
 * Every page the pane's session owns, plus the browsing context's own name.
 *
 * The context name rides the same frame as the pages rather than a second operation:
 * it is the strip's leading chip, it changes exactly when the run that owns the
 * context changes it, and a surface that read the two separately would render a chip
 * naming one context beside tabs belonging to another.
 */
export interface GrowthBrowserPageList {
  readonly contextName: string | null;
  readonly pages: readonly GrowthBrowserPage[];
}

/**
 * One keystroke the main process claimed from a page and handed back.
 *
 * The `KeyboardEvent` members a chord decision is made from, and no more: the console
 * decides which chords may be claimed from a mirror it publishes, and the frame that
 * comes back is the keystroke itself rather than a command name. That asymmetry is
 * the design's — the mirror holds which chords EXIST and never what they mean, so
 * nothing on this wire can name an action.
 *
 * `isComposing` rides it because an IME composition is never claimable and the
 * composition state is a property of the keystroke that only its own event knows.
 */
export interface GrowthAcceleratorChord {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}

export interface GrowthTerminalChunk {
  readonly terminalId: string;
  readonly data: string;
}

export interface GrowthPaneError {
  readonly paneId: string;
  readonly reason: string;
}
