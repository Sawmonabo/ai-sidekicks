// The session plane's values: a session as a directory row, an invite, a component
// health reading, and an import's progress.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys — why a shape earns a name, what belongs in the
// signature table instead, and what belongs in a module of its own — and publishes
// the whole set. Import from the barrel; this file is the domain's own text.

export interface GrowthSessionSummary {
  readonly sessionId: string;
  /**
   * Optional because a session may genuinely have no name, and
   * `Spec-023 §Console Design (Meridian)` says what happens then: it renders by its
   * identifier, never by an invented title. A required member would force every
   * producer to supply one, and the only value a producer without a title can
   * supply is a fabrication.
   */
  readonly title?: string;
  readonly state: string;
}

export interface GrowthInviteSummary {
  readonly inviteId: string;
  readonly state: string;
  readonly expiresAt: string;
}

export interface GrowthHealthReading {
  readonly component: string;
  readonly state: string;
  readonly observedAt: string;
}

export interface GrowthImportProgress {
  readonly importId: string;
  readonly turnsSeen: number;
  readonly state: string;
}
