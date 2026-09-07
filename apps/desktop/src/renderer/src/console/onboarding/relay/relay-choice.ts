// The three-way relay choice, with its normative identifiers and its consequences.
//
// `Spec-026 §Three-Way Choice Semantics` fixes the identifiers — `free-public-relay`
// (the default), `self-host`, `hosted-saas` — so they are transcribed here once and
// nothing in this console spells them a second time. They are the values that travel
// back on `onboarding.presentChoice`, so a typo would be a choice the daemon cannot
// record.
//
// THREE OPTIONS, ALL VISIBLE, NONE COLLAPSED. `Spec-026 §Pitfalls To Avoid` names
// collapsing the third option behind an advanced control as a defect, and the reason
// is legibility rather than symmetry: a person choosing where their session traffic
// goes is making a trust decision, and an option they have to go looking for is one
// they will not weigh. The `isDefault` flag below marks which arrives selected; it
// does not mean the others are secondary.
//
// AND NO SILENT DEFAULT. A default is what a control STARTS on, and this walkthrough
// still requires an explicit answer — `Spec-026 §Desktop Surface` makes the step
// non-dismissible until a choice is made — so nothing here is recorded until a person
// presses the step's primary action.
//
// WHAT EACH OPTION NEEDS IS NOT COLLECTED HERE, AND CANNOT BE. Self-host needs a
// relay URL, an admin-issued join token, and a first-connection fingerprint
// confirmation; hosted SaaS opens the system browser with a one-shot PKCE state.
// Every one of those is a secret or a browser hand-off, and `Spec-026 §Pitfalls To
// Avoid` records that "rendering the admin-token field in the renderer has already
// leaked it". So the inputs are main's, reached through `onboarding.presentChoice`,
// and this module carries only what a person reads before pressing.

/**
 * The three identifiers, in the order the step renders them. Closed; normative.
 *
 * `Spec-026 §Three-Way Choice Semantics` owns the values. The union is derived from
 * the tuple so the set the step walks and the set the type admits are one set.
 */
export const RELAY_METHOD_IDS = ["free-public-relay", "self-host", "hosted-saas"] as const;

export type RelayMethodId = (typeof RELAY_METHOD_IDS)[number];

export interface RelayMethodOption {
  readonly id: RelayMethodId;
  /** Sentence case, names the arrangement rather than the vendor. */
  readonly label: string;
  /** What choosing this means for the session's traffic. One sentence. */
  readonly consequence: string;
  /** What this option will ask for, said before it is asked for. */
  readonly inputs: string;
  /** Which option the control starts on. Exactly one, per the spec's own default. */
  readonly isDefault: boolean;
}

/**
 * The options, as data.
 *
 * A TOTAL record over the identifier union: a fourth relay arrangement added
 * upstream is a compile error here until its consequence and its inputs are written,
 * rather than an option that renders with a blank line where the trust decision goes.
 */
export const RELAY_METHOD_OPTIONS: Readonly<Record<RelayMethodId, RelayMethodOption>> = {
  "free-public-relay": {
    id: "free-public-relay",
    label: "The free public relay",
    consequence:
      "Session traffic is carried by the published relay, end-to-end encrypted, and this node needs no server of its own.",
    inputs: "Nothing to supply. The relay address comes from this node's own configuration.",
    isDefault: true,
  },
  "self-host": {
    id: "self-host",
    label: "A relay you run",
    consequence:
      "Session traffic is carried by a relay your organisation operates, and nothing about a session reaches anyone else's server.",
    inputs:
      "A relay address, a join token an administrator issues, and a confirmation of the relay's certificate fingerprint the first time this node connects. The token is typed in a window this one cannot read.",
    isDefault: false,
  },
  "hosted-saas": {
    id: "hosted-saas",
    label: "A hosted account",
    consequence:
      "Session traffic is carried by the hosted service under an account you sign in to, with its own retention and billing.",
    inputs:
      "A sign-in that happens in your browser. This window is handed a scoped token afterwards and never sees the credential.",
    isDefault: false,
  },
};

/** The options in render order, derived from the identifier tuple. */
export const RELAY_METHOD_OPTIONS_IN_ORDER: readonly RelayMethodOption[] = RELAY_METHOD_IDS.map(
  (id) => RELAY_METHOD_OPTIONS[id],
);

/**
 * Narrow a relay identifier the daemon reported, or answer `undefined`.
 *
 * FAIL-CLOSED. `onboarding.presentChoice` answers with a bare string, and an
 * identifier this build does not recognise is a choice made against a vocabulary this
 * console does not have — so it renders as the unrecognised reading rather than as
 * whichever of the three it looks nearest to.
 */
export function readRelayMethodId(candidate: string): RelayMethodId | undefined {
  return RELAY_METHOD_IDS.find((id) => id === candidate);
}
