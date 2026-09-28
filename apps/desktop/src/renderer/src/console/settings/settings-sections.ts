// The settings family's closed vocabulary: which sections exist, and what the rail calls
// them.
//
// A LEAF, AND THAT IS WHAT IT IS FOR. This was declared at the top of
// `settings-page-registry.ts` while the registry was the only module that needed it before
// its own consumers did. It stopped being true when the page registry grew a loader arm:
// the reserved region a loader-backed page renders while its chunk arrives names the
// section it is waiting on, so the component the registry constructs needs the section
// type the registry declares, and `PendingSettingsPageBody → settings-page-registry →
// PendingSettingsPageBody` is a cycle `no-circular` fails. That rule's own remedy is the
// hoist rather than a weakened type, and this is the lowest home both sides can read: a
// vocabulary and nothing else, importing nothing.
//
// Nothing here is a wire shape. A section id names a rail entry and a `#/settings/<page>`
// address segment, both of which are this renderer's own; the daemon is asked nothing
// about them, which is why the console may decide one.

/**
 * Every settings section, in rail order.
 *
 * Ten slots in a fixed order. The id and the rail label differ for four of them:
 * `application` is General, `accounts` is Providers, `mounts` is the Projects slot (its
 * label is "Mounts"), and `daemon` is Runtime; the tenth slot's id is `agents` and its
 * label "Sidekicks". The rail a person reads is this tuple, and the union is derived from
 * it for the reason `seats/surface/surface-registry.ts` gives about its own slots: a union
 * written beside a hand-repeated array is two closed sets that agree until one of them is
 * widened.
 */
export const SETTINGS_SECTION_IDS = [
  "application",
  "accounts",
  "mcp-servers",
  "mounts",
  "browser",
  "keyboard",
  "appearance",
  "notifications",
  "daemon",
  "agents",
] as const;

/** One settings section. Derived from the enumeration, never restated. */
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/**
 * The rail's label for each section, in one place.
 *
 * A TOTAL record, so an eleventh section is a compile error here until its label
 * is decided — the label cannot silently default to the id, which is how a rail
 * grows an entry reading `mcp-servers`.
 */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsSectionId, string>> = {
  application: "Application",
  accounts: "Accounts",
  "mcp-servers": "MCP servers",
  mounts: "Mounts",
  browser: "Browser",
  keyboard: "Keyboard",
  appearance: "Appearance",
  notifications: "Notifications",
  daemon: "Local runtime",
  agents: "Sidekicks",
};
