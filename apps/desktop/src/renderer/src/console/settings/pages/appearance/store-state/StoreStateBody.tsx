// The three states the store reading can be in, and what each one draws.
//
// WHAT IT RENDERS AND WHAT IT REFUSES TO. The store's own answer: which adapter, and
// whether that adapter is durable, in the store's own sentence rather than one
// paraphrased here — `describeQuotaUnavailability` and `PersistenceAdapter.describe`
// are the one vocabulary for why durable storage is not in use, and a second sentence
// written beside them is how two surfaces come to disagree about `open-timed-out`.
//
// The gauge is rendered where it was measured and left blank where it was not: an
// unmeasured quota is `undefined` on the gauge's own shape, and "0 bytes of 0" would
// be a reading nobody took presented as one somebody did.

import type { ReactNode } from "react";

import { describeQuotaUnavailability, type QuotaGauge } from "../../../../persistence/index.js";
import {
  Chip,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatByteQuantity,
  formatCount,
} from "../../../../primitives/index.js";
import { DefinitionGrid } from "../../../shared/DefinitionGrid.js";
import { incidentsOf, type StoreStateReading } from "./store-state-reading.js";

/** A measured figure, or the em dash that says the reading was not taken. */
function byteReading(byteCount: number | undefined): string {
  return byteCount === undefined ? "—" : formatByteQuantity(byteCount).text;
}

/** What the gauge says about room, in the gauge's own three-value vocabulary. */
function pressureLabel(pressure: QuotaGauge["pressure"]): string {
  return pressure === "unknown" ? "room not measured" : `room ${pressure}`;
}

export function StoreStateBody(props: { readonly reading: StoreStateReading }): ReactNode {
  const { reading } = props;
  if (reading.kind === "unread") {
    return <Nothing kind="not-loaded" placement="inline" title="Asking the store how it is." />;
  }
  if (reading.kind === "unreadable") {
    return <InlineRefusal code={reading.refusal.code} detail={reading.refusal.detail} />;
  }
  const { health } = reading;
  const unavailability = describeQuotaUnavailability(health.quota);
  const incidents = incidentsOf(health);
  return (
    <>
      <div className="meridian-settings-page__chips">
        <Chip
          tone={health.durable ? "neutral" : "attention"}
          label={health.durable ? "kept on disk" : "this window only"}
          glyph={health.durable ? "check" : "alert"}
        />
        <Chip tone="neutral" label={health.adapterKind} mono />
        <Chip tone="neutral" label={pressureLabel(health.quota.pressure)} />
      </div>
      <p className="meridian-settings-page__aside">{health.description}</p>
      {unavailability === undefined ? null : (
        <p className="meridian-settings-page__aside">{unavailability}</p>
      )}
      <DefinitionGrid
        entries={[
          {
            key: "usage",
            term: "In use",
            definition: <WireFigure value={byteReading(health.quota.usageBytes)} />,
          },
          {
            key: "quota",
            term: "Allowed",
            definition: <WireFigure value={byteReading(health.quota.quotaBytes)} />,
          },
        ]}
      />
      {incidents.length === 0 ? null : (
        <DefinitionGrid
          entries={incidents.map((incident) => ({
            key: incident.label,
            term: <WireFigure value={incident.label} />,
            definition: formatCount(incident.count),
          }))}
        />
      )}
    </>
  );
}
