// The base state, driven all the way through to the role a surface gates on.
//
// The defect these cases exist for rendered as nothing: the fixture served a
// successful caller-identity read naming a participant the store had never heard of,
// because the base state carried no entities and the composition root registers no
// `membership.*` projector. Every owner- and collaborator-gated control therefore
// rendered closed under every scenario, which on screen is indistinguishable from a
// member who genuinely has no elevated role — so no surface, screenshot, or review
// could have caught it.
//
// The first case is therefore END TO END on purpose: the shipped fixture port answers
// the read, a real `SessionStore` is established from it, and the shipped
// `membershipRoleOf` resolves the role. A case that asserted the snapshot's entities
// and stopped there would have gone green against a body member no selector reads.
//
// The negative control beside it establishes the same store from the entity-free base
// state the port used to serve, and shows the role resolving to nothing — which is
// what makes the first case an assertion about the roster rather than about the
// lookup happening to answer.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "./fixture-bridge.js";
import { fixtureSessionSnapshot } from "./fixture-session-snapshot.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { membershipRoleOf } from "./entity-body-reads.js";
import type { ConsoleEntity } from "../store/index.js";
import { SessionStore } from "../store/session-store.js";
import type { SessionSnapshot } from "../store/session-store.js";

/** The viewer every flagship case resolves, named once so a failure says which id. */
const FLAGSHIP_VIEWER = FLAGSHIP_SCENARIO.viewingParticipantId ?? "";

/** The roles the flagship scenario declares, read rather than restated. */
const FLAGSHIP_ROLES = FLAGSHIP_SCENARIO.membershipRoleByParticipantId ?? {};

/** A store established from one base state, so every case reads the same construction. */
function storeEstablishedFrom(snapshot: SessionSnapshot): SessionStore {
  const store = new SessionStore({ sessionId: FLAGSHIP_SCENARIO.sessionId });
  store.initialise(snapshot);
  return store;
}

/** The base state the shipped fixture port serves for the flagship's own session. */
async function servedFlagshipSnapshot(): Promise<SessionSnapshot> {
  const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
  const outcome = await bridge.growth.sessionRead({ sessionId: FLAGSHIP_SCENARIO.sessionId });
  if (outcome.status !== "served") {
    throw new Error(`the fixture refused the session read: ${outcome.code}`);
  }
  return outcome.value;
}

/** The roster entry the read established for one participant, or `undefined`. */
function rosterEntryOf(store: SessionStore, participantId: string): ConsoleEntity | undefined {
  return store.snapshot().partitions.participant[participantId];
}

describe("the fixture's base state — the roster a store opens with", () => {
  it("resolves the caller's own role through the store the read establishes", async () => {
    const store = storeEstablishedFrom(await servedFlagshipSnapshot());

    expect(membershipRoleOf(rosterEntryOf(store, FLAGSHIP_VIEWER))).toBe(
      FLAGSHIP_ROLES[FLAGSHIP_VIEWER],
    );
    // Not `undefined`, stated separately: the comparison above would hold vacuously
    // if the scenario declared no role for its viewer and the lookup found none.
    expect(membershipRoleOf(rosterEntryOf(store, FLAGSHIP_VIEWER))).toBeDefined();
  });

  it("negative control: the entity-free base state resolves no role at all", async () => {
    // The state the port served before this module existed — the same cursor, the
    // same join log, and no entities. The read succeeded, the identity was
    // well-formed, and every role gate closed.
    const served = await servedFlagshipSnapshot();
    const store = storeEstablishedFrom({ ...served, entities: [] });

    expect(membershipRoleOf(rosterEntryOf(store, FLAGSHIP_VIEWER))).toBeUndefined();
  });

  it("carries one row per declared membership, in join order", () => {
    const snapshot = fixtureSessionSnapshot(FLAGSHIP_SCENARIO, FLAGSHIP_SCENARIO.sessionId);

    expect(snapshot.entities.map((entity) => entity.id)).toStrictEqual(
      FLAGSHIP_SCENARIO.participantIdsInJoinOrder.filter((participantId) =>
        Object.hasOwn(FLAGSHIP_ROLES, participantId),
      ),
    );
    expect(snapshot.entities.every((entity) => entity.kind === "participant")).toBe(true);
  });

  it("files no participant row for an agent, which holds no membership", () => {
    // The join order holds everything that takes a hue, agents included, and this
    // scenario's four agents are most of it — so a derivation that filed the whole
    // join order would produce six rows, four of them resolving to a role no daemon
    // granted. The strict inequality is what makes the case above non-vacuous.
    const snapshot = fixtureSessionSnapshot(FLAGSHIP_SCENARIO, FLAGSHIP_SCENARIO.sessionId);

    expect(snapshot.entities.length).toBeLessThan(
      FLAGSHIP_SCENARIO.participantIdsInJoinOrder.length,
    );
    const store = storeEstablishedFrom(snapshot);
    for (const participantId of FLAGSHIP_SCENARIO.participantIdsInJoinOrder) {
      if (Object.hasOwn(FLAGSHIP_ROLES, participantId)) {
        continue;
      }
      expect(membershipRoleOf(rosterEntryOf(store, participantId)), participantId).toBeUndefined();
    }
  });

  it("lends no session's roster to another, a role being a fact about one roster", () => {
    const snapshot = fixtureSessionSnapshot(FLAGSHIP_SCENARIO, "session-somebody-else");

    expect(snapshot.entities).toStrictEqual([]);
    expect(snapshot.participantJoinLog).toStrictEqual([]);
  });

  it("answers at the bottom of the stream, so the store admits the first beat", () => {
    // Zero rather than a position derived from the beats: a base state ahead of the
    // stream would have the store discard every beat below it, and the subscription
    // is replay-then-tail.
    expect(fixtureSessionSnapshot(FLAGSHIP_SCENARIO, FLAGSHIP_SCENARIO.sessionId).cursor).toBe(0);
  });
});
