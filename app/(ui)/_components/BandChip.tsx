/**
 * A colour-band chip (design/prototype.html · `.chip`). Drives its colour + label from `BAND_META`,
 * which mirrors the DB `type_color_map` / `color_band` config. Presentational and pure — reused by
 * the plan worklist and (later) lookup, line detail, and settings. Optionally shows the band name.
 */

import { bandMeta } from "./plan-meta";

export function BandChip({ bandKey, label }: { bandKey: string; label?: boolean }) {
  const m = bandMeta(bandKey);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <span
        className={"chip" + (m.dither ? " dither" : "")}
        style={{ background: m.color }}
        title={m.display}
        aria-label={m.display}
      />
      {label ? <span className="u">{m.display}</span> : null}
    </span>
  );
}
