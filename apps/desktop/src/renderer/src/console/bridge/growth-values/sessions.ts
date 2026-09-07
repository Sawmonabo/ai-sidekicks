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

/**
 * Whether this machine will display an OS notification for this application.
 *
 * THREE ARMS AND NOT TWO, because the third is the one a fresh install is in.
 * `granted` and `denied` are answers; `not-determined` is the state before anyone
 * has been asked, and folding it onto `denied` would make the notification centre
 * announce that it is the only surface for a machine that would happily show a
 * notification the first time one is emitted.
 *
 * A CLOSED SET RATHER THAN A WIRE-VERBATIM STRING, which is the opposite of what
 * `GrowthHealthReading.state` above does — and the difference is which side owns the
 * vocabulary. A health state is a daemon's own word and the console renders it; this
 * reading has no wire at all, so its slate row's eventual owner takes the console's
 * three arms as the requirement rather than the console guessing at somebody else's
 * enumeration. Each arm is rendered differently, which is what makes closing it worth
 * anything: only `denied` says the centre is the only surface.
 */
export interface GrowthNotificationPermission {
  readonly state: "granted" | "denied" | "not-determined";
}
