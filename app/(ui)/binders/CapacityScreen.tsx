"use client";

/**
 * Capacity review — per binder (dev-spec §5 M8; system-design §7E; UIL-055).
 *
 * Each binder shows capacity, shelved, block pockets, open placeholders, and free space per half,
 * flags near-full sections, and answers "which binder has room for a new Fire line" up top.
 * Front and back are ONE binder card here (she is objecting to the presentation reading as two
 * binders, not to the underlying per-half model — capacity math still needs the half, since front and
 * back hold genuinely different things). Clicking a card reveals its shelved cards, image-first, per
 * her standing design principle: folded by default and mounting nothing until expanded, the same
 * discipline UIL-034 established for Collections, so this never starts out with UIL-034's problem.
 *
 * Read-only; client-driven so there is no DB access at build/prerender time.
 */

import { useEffect, useState } from "react";
import { CardFace } from "../_components/CardFace";
import { isUnreached, LOST, reach } from "../_components/reach";
import { loadBinderCards, loadCapacity } from "./actions";
import type { BinderCardTile, CapacityData, CapacitySection } from "./binders-types";

const HALF_LABEL: Record<string, string> = { front: "FRONT", back: "BACK", single: "SPECIALTY" };
const FULLNESS_LABEL: Record<string, string> = {
  full: "FULL",
  near: "NEAR FULL",
  ok: "ROOM",
  empty: "UNSIZED",
};
/** Worst-first, for picking one flag to represent a binder's several sections at a glance. */
const FULLNESS_SEVERITY: Record<string, number> = { full: 3, near: 2, ok: 1, empty: 0 };

interface BinderGroup {
  binderId: string;
  binderName: string;
  binderType: "general" | "specialty";
  sections: CapacitySection[];
}

function groupByBinder(sections: CapacitySection[]): BinderGroup[] {
  const order: string[] = [];
  const groups = new Map<string, BinderGroup>();
  for (const s of sections) {
    let g = groups.get(s.binderId);
    if (!g) {
      g = {
        binderId: s.binderId,
        binderName: s.binderName,
        binderType: s.binderType,
        sections: [],
      };
      groups.set(s.binderId, g);
      order.push(s.binderId);
    }
    g.sections.push(s);
  }
  return order.map((id) => groups.get(id)!);
}

export function CapacityScreen() {
  const [data, setData] = useState<CapacityData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Collapsed by default (UIL-055/UIL-034): mount nothing until she asks for it.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Through `reach` (UIL-109): a failed load says so in the shared words, never the raw error text.
    void reach(() => loadCapacity(), LOST.load).then((d) =>
      isUnreached(d) ? setError(d.error) : setData(d),
    );
  }, []);

  function toggle(binderId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(binderId)) next.delete(binderId);
      else next.add(binderId);
      return next;
    });
  }

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

  const groups = groupByBinder(data.sections);

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

      {groups.length === 0 && (
        <div className="stub panel">
          <p>No binders yet. Add one in Settings.</p>
        </div>
      )}

      <div className="capgrid">
        {groups.map((g) => (
          <BinderCard
            key={g.binderId}
            g={g}
            expanded={expanded.has(g.binderId)}
            onToggle={() => toggle(g.binderId)}
          />
        ))}
      </div>

      <div className="foot">
        CAPACITY = PAGES-IN-HALF × POCKETS. COARSE ONLY — NO PAGE, NO POCKET.
      </div>
    </div>
  );
}

function BinderCard({
  g,
  expanded,
  onToggle,
}: {
  g: BinderGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  const worst = g.sections.reduce(
    (acc, s) => (FULLNESS_SEVERITY[s.fullness] > FULLNESS_SEVERITY[acc] ? s.fullness : acc),
    g.sections[0]?.fullness ?? "empty",
  );
  return (
    <div className={"capcard panel fill-" + worst}>
      <button type="button" className="capfold" onClick={onToggle} aria-expanded={expanded}>
        <span aria-hidden>{expanded ? "▼" : "▶"}</span>
        <span className="nm u">{g.binderName}</span>
        <span className={"flag u flag-" + worst} style={{ marginLeft: "auto" }}>
          {FULLNESS_LABEL[worst] ?? ""}
        </span>
      </button>

      {g.sections.map((s) => (
        <SectionRow key={s.half} s={s} />
      ))}

      {expanded && <BinderCardGrid binderId={g.binderId} />}
    </div>
  );
}

function SectionRow({ s }: { s: CapacitySection }) {
  const used = s.shelvedCount + s.blockPockets + s.openPlaceholders;
  const pct = s.capacity > 0 ? Math.min(100, Math.round((used / s.capacity) * 100)) : 0;
  return (
    <div className="capsection">
      {s.half !== "single" && <div className="half u">{HALF_LABEL[s.half] ?? s.half}</div>}
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
      <div className="sl u">{label}</div>
      <div className={"sv" + (strong ? " strong" : "")}>{value}</div>
    </div>
  );
}

/** The binder's shelved cards, both halves unioned — fetched only once expanded. */
function BinderCardGrid({ binderId }: { binderId: string }) {
  const [cards, setCards] = useState<BinderCardTile[] | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void reach(() => loadBinderCards(binderId), LOST.load).then((rows) => {
      if (!alive) return;
      if (isUnreached(rows)) setGridError(rows.error);
      else setCards(rows);
    });
    return () => {
      alive = false;
    };
  }, [binderId]);

  if (gridError) {
    return <div className="cehint u">{gridError}</div>;
  }
  if (!cards) {
    return <div className="cehint u">Reading this binder…</div>;
  }
  if (cards.length === 0) {
    return <div className="cehint u">Nothing shelved here yet.</div>;
  }

  // `cards` is already sorted front-then-back (`loadBinderCards`), so a contiguous-run grouping is
  // enough — no separate sort/bucket step needed. One binder, one card, but the half stays legible as
  // a header inside it rather than as a pill on every tile (she objected to two CARDS, not to knowing
  // which half a card sits in). Skipped entirely when only one half is present.
  const groups: { half: string; cards: BinderCardTile[] }[] = [];
  for (const c of cards) {
    const last = groups[groups.length - 1];
    if (last && last.half === c.half) last.cards.push(c);
    else groups.push({ half: c.half, cards: [c] });
  }
  const showHeaders = groups.length > 1;

  return (
    <div style={{ marginTop: 10 }}>
      {groups.map((grp, i) => (
        <div key={i}>
          {showHeaders && (
            <div className="cghead u" style={{ marginTop: i === 0 ? 0 : 10 }}>
              {HALF_LABEL[grp.half] ?? grp.half}
            </div>
          )}
          <div className="cgrid" style={{ marginTop: showHeaders ? 6 : 0 }}>
            {grp.cards.map((c) => (
              <div key={c.copyId} className="ccard">
                <CardFace name={c.name} tcgdexId={c.tcgdexId} imageUrl={c.imageUrl} size="m" />
                <div className="cn u">{c.name}</div>
                {c.localId ? <div className="cno">{c.localId}</div> : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
