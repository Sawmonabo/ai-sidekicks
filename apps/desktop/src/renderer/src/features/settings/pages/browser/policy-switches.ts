// The two node-wide browser switches, as the console names them.
//
// Held apart from the page and the row so neither imports the other's shapes. The union is
// derived from the tuple, so a third switch cannot be added to one without the other.

/** The two switches, as console-local ids. */
export const BROWSER_POLICY_SWITCHES = ["file-boundary", "page-tools"] as const;

/** One browser policy switch id. */
export type BrowserPolicySwitchId = (typeof BROWSER_POLICY_SWITCHES)[number];

/** Flip one switch to the position it asks for. */
export type BrowserPolicySwitchWriter = (
  switchId: BrowserPolicySwitchId,
  nextEnabled: boolean,
) => void;
