// Provider-bound text: the words the daemon hands a provider, unchanged, with who composed them.

/** Who composed a piece of provider-bound text. */
type OutboundTextOrigin = "human_text" | "system_narration" | "driver_command";

/** Text the daemon sends a provider, as typed, with who composed it. */
export interface OutboundText {
  readonly text: string;
  readonly origin: OutboundTextOrigin;
}
