// The two node-wide browser switches, as the console names them.
//
// Held apart from the page and the row that render them because both take the same
// shapes, and a shape exported by one and imported by the other would close a cycle
// between siblings that only ever read it.
//
// CLOSED AT TWO. Settings holds the two node-wide switches the browser pane's policy
// reads and nothing else about the browser, and the union is DERIVED from the tuple, so
// a third cannot be added to one without the other.

/** The two switches, as console-local ids. */
export const BROWSER_POLICY_SWITCHES = ["file-boundary", "page-tools"] as const;

export type BrowserPolicySwitchId = (typeof BROWSER_POLICY_SWITCHES)[number];

/** Flip one switch to the position it asks for. */
export type BrowserPolicySwitchWriter = (
  switchId: BrowserPolicySwitchId,
  nextEnabled: boolean,
) => void;
