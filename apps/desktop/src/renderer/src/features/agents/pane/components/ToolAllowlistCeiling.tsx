// The ceiling a tool allowlist cannot raise, said once for the whole roster. It is a node-wide
// fact, so its subject is the mechanism ("applied at spawn"), not one agent; a card would make it
// a claim about that agent. It offers no control: the switch lives on the browser settings page.

/** The ceiling, once, above a roster that has at least one agent to state it about. */
export function ToolAllowlistCeiling(): React.JSX.Element {
  return (
    <p className="meridian-agents__allowlist-note">
      A tool allowlist is applied at spawn and filters the browser page tool set like any other
      source; a node-wide switch on the browser settings page withholds those tools from every later
      spawn here, and an allowlist cannot turn them back on.
    </p>
  );
}
