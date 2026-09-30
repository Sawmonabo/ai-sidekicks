// The bridge's shape, read at runtime. The fixture bridge must carry the preload's namespaces
// exactly. Types cover most of that, since both bridges are `PlatformBridge`, but the live bridge
// is an object graph handed across `contextBridge` by a preload this program does not compile
// with, so this is the runtime check. `live-bridge.ts` reads its namespace list to tell whether the
// preload ran.
//
// A shape maps each namespace to its member names, each with its `typeof`, and data members count
// as much as methods. The `typeof` separates a missing member from one that is there with the
// wrong type, which is how a half-installed preload arrives.
import type { PreloadApi } from "@shared/preload-api.js";
import type { PlatformBridge } from "./platform-bridge.js";

/** One namespace name. The contract's own `keyof` — never a second spelling. */
export type DesktopBridgeNamespace = keyof PreloadApi;

/**
 * Every namespace the contract declares, as a table. The annotation makes it exhaustive in both
 * directions: a namespace missing here, or one not on `PreloadApi`, is a compile error. A plain
 * array would type-check each entry but count none, so the probe would miss a fifth namespace.
 */
const BRIDGE_NAMESPACE_PRESENCE: Readonly<Record<DesktopBridgeNamespace, true>> = {
  daemon: true,
  controlPlane: true,
  native: true,
  update: true,
  machineSettings: true,
  keyboardMap: true,
  window: true,
  browser: true,
  app: true,
};

/**
 * The namespaces, as data. `Object.keys` of a fresh literal returns exactly its own keys, so the
 * narrowing is sound and the names are not spelled a second time.
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
 * The bridge's members that are not preload namespaces: the signals every host answers. Keyed by
 * the type, so a new signal fails to compile until listed and the shape stays a reading of the
 * preload's namespaces alone.
 */
const BRIDGE_SIGNAL_MEMBERS: Readonly<
  Record<Exclude<keyof PlatformBridge, DesktopBridgeNamespace>, true>
> = {
  transportReconnect: true,
  source: true,
};

/**
 * Reads a bridge's shape from own enumerable keys at both levels. `contextBridge` hands the
 * renderer a plain object graph, so own keys are every member, while the prototype chain would add
 * `Object`'s members. It takes `PlatformBridge`, not `unknown`, and describes without deciding
 * whether the description is acceptable.
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
 * Every way two shapes differ, one sentence each; empty means identical. Sentences rather than a
 * boolean so a failed assertion names the namespace or member that moved.
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
    // Not a namespace: reported as zero members, not thrown, so a bridge whose `app` arrived as a
    // string is described as empty and rejected by the comparison.
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
