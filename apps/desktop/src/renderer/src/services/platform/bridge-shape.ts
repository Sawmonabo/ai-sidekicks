// The bridge's shape, read at runtime.
//
// The fixture bridge has to carry the preload's namespaces, shape-identical namespace for
// namespace. The type system carries most of that
// claim already — both bridges ARE `PlatformBridge`, so a namespace added to the
// contract breaks the fixture at compile time — but not all of it. The live bridge
// is an object graph handed across `contextBridge` by a preload this program does
// not compile with, so on THAT side the interface is a claim about a value nobody
// checked. This module is the runtime half, and it has two readers: `live-bridge`'s
// "did the preload run" probe, and `bridge-shape.test.ts`.
//
// A shape is namespace to member names, and each member carries its `typeof`. Data
// members count as much as methods: `app` holds four strings and no functions, and
// a bridge that dropped `locale` would be as wrong as one that dropped
// `daemon.call`. The `typeof` is what separates "the member is missing" from "the
// member is there and is a string where a function belongs", which is the shape a
// half-installed preload actually arrives in.
import type { PreloadApi } from "@shared/preload-api.js";
import type { PlatformBridge } from "./platform-bridge.js";

/** One namespace name. The contract's own `keyof` — never a second spelling. */
export type DesktopBridgeNamespace = keyof PreloadApi;

/**
 * Every namespace the contract declares, as a table rather than an array.
 *
 * The annotation is what makes this exhaustive in BOTH directions on a fresh object
 * literal: a namespace added to `PreloadApi` is a missing-property error here
 * until it is listed, and a name that is not on the contract is an excess-property
 * error. The array this replaced was a plain `readonly (keyof PreloadApi)[]`,
 * which type-checks each entry and counts none — so it would have gone on probing
 * the namespaces it was written against however many the contract grew, and the probe would have kept
 * answering yes to a bridge missing the fifth.
 */
const BRIDGE_NAMESPACE_PRESENCE: Readonly<Record<DesktopBridgeNamespace, true>> = {
  daemon: true,
  controlPlane: true,
  native: true,
  update: true,
  app: true,
};

/**
 * The namespaces, as data.
 *
 * `Object.keys` of a fresh object literal returns exactly that literal's own
 * enumerable keys, which is why the narrowing is sound — the alternative is
 * spelling the namespace names a second time, and a second spelling is the thing the
 * presence table above exists to prevent.
 */
export const DESKTOP_BRIDGE_NAMESPACES: readonly DesktopBridgeNamespace[] = Object.keys(
  BRIDGE_NAMESPACE_PRESENCE,
) as DesktopBridgeNamespace[];

/** One bridge's runtime members: namespace to `member: typeof` entries, sorted. */
export type BridgeShape = ReadonlyMap<string, readonly string[]>;

/** A shape and what to call it in a difference report. */
export interface LabeledBridgeShape {
  readonly label: string;
  readonly shape: BridgeShape;
}

/**
 * The bridge's members that are not preload namespaces: the signals every host answers.
 * Keyed by the type, so a signal added to `PlatformBridge` fails to compile until it is
 * listed, and the shape stays a reading of the preload's namespaces alone.
 */
const BRIDGE_SIGNAL_MEMBERS: Readonly<
  Record<Exclude<keyof PlatformBridge, DesktopBridgeNamespace>, true>
> = {
  transportReconnect: true,
  source: true,
};

/**
 * Read a bridge's shape.
 *
 * OWN enumerable keys only, at both levels. `contextBridge` hands the renderer a
 * plain object graph — nothing is a class instance and nothing inherits — so the
 * own keys are every member there is, while walking the prototype chain would pick up
 * `Object`'s members and make every namespace look alike.
 *
 * Takes `PlatformBridge` and not `unknown`: the callers hold typed bridges, and a
 * parameter that accepted anything would invite this to become a validator. It
 * describes; deciding whether a description is acceptable belongs to the caller.
 */
export function describeBridgeShape(bridge: PlatformBridge): BridgeShape {
  const shape = new Map<string, readonly string[]>();
  for (const [namespace, namespaceValue] of Object.entries(bridge)) {
    if (Object.hasOwn(BRIDGE_SIGNAL_MEMBERS, namespace)) {
      continue;
    }
    shape.set(namespace, describeMembers(namespaceValue));
  }
  return shape;
}

/**
 * Every way two shapes differ, one sentence each. An empty result means identical.
 *
 * Sentences rather than a boolean because the assertion this feeds is "these two
 * bridges are the same", and a bare `false` on that assertion tells the reader
 * nothing about which namespace or which member moved.
 */
export function diffBridgeShapes(
  left: LabeledBridgeShape,
  right: LabeledBridgeShape,
): readonly string[] {
  const differences: string[] = [];
  const namespaces = [...new Set([...left.shape.keys(), ...right.shape.keys()])].sort();

  for (const namespace of namespaces) {
    const leftMembers = left.shape.get(namespace);
    const rightMembers = right.shape.get(namespace);
    if (leftMembers === undefined) {
      differences.push(`namespace ${namespace} is on ${right.label} and not on ${left.label}`);
      continue;
    }
    if (rightMembers === undefined) {
      differences.push(`namespace ${namespace} is on ${left.label} and not on ${right.label}`);
      continue;
    }
    for (const member of missingFrom(leftMembers, rightMembers)) {
      differences.push(`${namespace}.${member} is on ${left.label} and not on ${right.label}`);
    }
    for (const member of missingFrom(rightMembers, leftMembers)) {
      differences.push(`${namespace}.${member} is on ${right.label} and not on ${left.label}`);
    }
  }

  return differences;
}

function describeMembers(namespaceValue: unknown): readonly string[] {
  if (typeof namespaceValue !== "object" || namespaceValue === null) {
    // Not a namespace at all. Reported as zero members rather than thrown, so a
    // bridge whose `app` arrived as a string is DESCRIBED as empty and then
    // rejected by the comparison, instead of taking the describer down with it.
    return [];
  }
  return Object.entries(namespaceValue)
    .map(([member, memberValue]) => `${member}: ${typeof memberValue}`)
    .sort();
}

function missingFrom(present: readonly string[], candidate: readonly string[]): readonly string[] {
  const known = new Set(candidate);
  return present.filter((member) => !known.has(member));
}
