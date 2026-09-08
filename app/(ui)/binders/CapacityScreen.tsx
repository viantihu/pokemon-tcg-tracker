"use client";

/**
 * Capacity review — per `binder_section` (dev-spec §5 M8; system-design §7E).
 *
 * Each section shows capacity, shelved, block pockets, open placeholders, and free space, flags
 * near-full sections, and answers "which binder has room for a new Fire line" up top. Read-only;
 * client-driven so there is no DB access at build/prerender time.
 */

import { useEffect, useState } from "react";
import { loadCapacity } from "./actions";
import type { CapacityData, CapacitySection } from "./binders-types";

const HALF_LABEL: Record<string, string> = { front: "FRONT", back: "BACK", single: "SPECIALTY" };
const FULLNESS_LABEL: Record<string, string> = {
  full: "FULL",
  near: "NEAR FULL",
  ok: "ROOM",
  empty: "UNSIZED",
};

export function CapacityScreen() {
  const [data, setData] = useState<CapacityData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCapacity()
      .then(setData)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Could not load capacity. Is the DB reachable?"),
      );
  }, []);

  if (error) {
    return (
      <div className="alertbar" role="alert" style={{ background: "#FFD9DF" }}>
        <span>!</span>
        <b>{error}</b>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="stub panel">
        <p>Reading capacity…</p>
      </div>
    );
  }

  return (
    <div className="capwrap">
      <div className="collhd panel">
        <span className="hk u">Binders & Capacity</span>
        <span className="hv u" style={{ marginLeft: "auto" }}>
          Capacity · Shelved · Blocks · Placeholders · Free
        </span>
      </div>

      <div className="roombar panel">
        <span className="hk u">Room for a new line</span>
        {data.roomForLine.length === 0 ? (
          <span className="u" style={{ fontSize: 11, color: "var(--ink-2)" }}>
            No back half has clear room — time for a new binder.
          </span>
        ) : (
          <div className="roomchips">
            {data.roomForLine.map((r) => (
              <span key={r.binderId} className="roomchip u">
                {r.binderName} · {r.freePockets} free
              </span>
            ))}
          </div>
        )}
      </div>

      {data.sections.length === 0 && (
        <div className="stub panel">
          <p>No binders yet. Add one in Settings.</p>
        </div>
      )}

      <div className="capgrid">
        {data.sections.map((s) => (
          <SectionCard key={`${s.binderId}-${s.half}`} s={s} />
        ))}
      </div>

      <div className="foot">
        CAPACITY = PAGES-IN-HALF × POCKETS. COARSE ONLY — NO PAGE, NO POCKET.
      </div>
    </div>
  );
}

function SectionCard({ s }: { s: CapacitySection }) {
  const used = s.shelvedCount + s.blockPockets + s.openPlaceholders;
  const pct = s.capacity > 0 ? Math.min(100, Math.round((used / s.capacity) * 100)) : 0;
  return (
    <div className={"capcard panel fill-" + s.fullness}>
      <div className="caphead">
        <span className="nm u">{s.binderName}</span>
        <span className="half u">{HALF_LABEL[s.half] ?? s.half.toUpperCase()}</span>
        <span className={"flag u flag-" + s.fullness}>{FULLNESS_LABEL[s.fullness] ?? ""}</span>
      </div>
      <div className="cbar">
        <i
          style={{ width: `${pct}%` }}
          className={s.fullness === "full" || s.fullness === "near" ? "hot" : ""}
        />
      </div>
      <div className="capnums">
        <Stat label="Capacity" value={s.capacity} />
        <Stat label="Shelved" value={s.shelvedCount} />
        <Stat label="Blocks" value={s.blockPockets} />
        <Stat label="Placeholders" value={s.openPlaceholders} />
        <Stat label="Free" value={s.freePockets} strong />
      </div>
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="capstat">
      <div className={"sv" + (strong ? " strong" : "")}>{value}</div>
      <div className="sl u">{label}</div>
    </div>
  );
}
