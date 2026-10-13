import type { Root } from "mdast";

/** A node's place in the parsed text, as mdast types it. */
export type Position = NonNullable<Root["position"]>;

/** One end of a `Position`. */
export type Point = Position["start"];
