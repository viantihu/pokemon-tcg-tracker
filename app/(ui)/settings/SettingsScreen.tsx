"use client";

/**
 * Settings (dev-spec §5 M8; system-design §4).
 *
 * Three panels: binders (pages / pockets / half-split / active), the rainbow order, and the
 * type→band map. Editing the map recomputes stored bands server-side and reports how many copies
 * moved. The empty Pink band is always shown — its rainbow slot reserves physical space and must
 * never be hidden or collapsed.
 */

import { useCallback, useEffect, useState } from "react";
import { BandChip } from "../_components/BandChip";
import { deleteBinder, loadSettings, reorderBands, saveBinder, setTypeBand } from "./actions";
import type { BandRow, BinderInput, SettingsData } from "./settings-types";

const BLANK_BINDER: BinderInput = {
  id: null,
  name: "",
  type: "general",
  pages: 40,
  pocketsPerPage: 9,
  backHalfStartPage: 21,
  isActive: false,
};

export function SettingsScreen() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<BinderInput | null>(null);

  // Reused by mutation handlers. setState lands only inside .then/.catch (never synchronously).
  const refresh = useCallback(
    () =>
      loadSettings().then(
        (d) => setData(d),
        (e) =>
          setError(
            e instanceof Error ? e.message : "Could not load settings. Is the DB reachable?",
          ),
      ),
    [],
  );
  useEffect(() => {
    let alive = true;
    loadSettings()
      .then((d) => alive && setData(d))
      .catch(
        (e) =>
          alive &&
          setError(
            e instanceof Error ? e.message : "Could not load settings. Is the DB reachable?",
          ),
      );
    return () => {
      alive = false;
    };
  }, []);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, okMsg?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      else {
        await refresh();
        if (okMsg) flash(okMsg);
      }
      return res.ok;
    } finally {
      setBusy(false);
    }
  }

  async function onSaveBinder() {
    if (!editing) return;
    const ok = await run(() => saveBinder(editing), "Binder saved");
    if (ok) setEditing(null);
  }

  async function onSetTypeBand(cardType: string, band: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await setTypeBand(cardType, band);
      if (!res.ok) setError(res.error);
      else {
        await refresh();
        flash(
          `Remapped ${cardType} → recomputed ${res.data?.copies ?? 0} copy band(s), ${res.data?.lines ?? 0} line(s)`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  function moveBand(index: number, dir: -1 | 1) {
    if (!data) return;
    const keys = data.bands.map((b) => b.band);
    const j = index + dir;
    if (j < 0 || j >= keys.length) return;
    [keys[index], keys[j]] = [keys[j], keys[index]];
    void run(() => reorderBands(keys));
  }

  if (error && !data) {
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
        <p>Loading settings…</p>
      </div>
    );
  }

  return (
    <div className="setwrap">
      {error && (
        <div className="alertbar" role="alert" style={{ background: "#FFD9DF" }}>
          <span>!</span>
          <b>{error}</b>
        </div>
      )}
      {toast && (
        <div className="alertbar ok">
          <span>✓</span>
          <b>{toast}</b>
        </div>
      )}

      {/* ---- Binders ---- */}
      <section className="setpanel panel">
        <div className="sethead">
          <span className="hk u">Binders</span>
          <button
            className="btn u"
            style={{ marginLeft: "auto" }}
            onClick={() => setEditing({ ...BLANK_BINDER })}
            disabled={busy}
          >
            ＋ New binder
          </button>
        </div>
        <div className="binderlist">
          {data.binders.map((b) => (
            <div key={b.id} className="binderrow">
              <div style={{ minWidth: 0 }}>
                <div className="nm u">
                  {b.name}
                  {b.isActive ? (
                    <span className="tag" style={{ marginLeft: 8 }}>
                      ACTIVE
                    </span>
                  ) : null}
                </div>
                <div className="meta u">
                  {b.type} · {b.pages} pages × {b.pocketsPerPage}
                  {b.type === "general" && b.backHalfStartPage
                    ? ` · back from p${b.backHalfStartPage}`
                    : ""}
                </div>
              </div>
              <button
                className="editcollbtn u"
                onClick={() =>
                  setEditing({
                    id: b.id,
                    name: b.name,
                    type: b.type,
                    pages: b.pages,
                    pocketsPerPage: b.pocketsPerPage,
                    backHalfStartPage: b.backHalfStartPage,
                    isActive: b.isActive,
                  })
                }
                disabled={busy}
              >
                ✎ Edit
              </button>
              <button
                className="editcollbtn u"
                onClick={() => {
                  if (confirm(`Delete "${b.name}"?`)) void run(() => deleteBinder(b.id));
                }}
                disabled={busy}
              >
                ✕
              </button>
            </div>
          ))}
          {data.binders.length === 0 && (
            <p style={{ fontSize: 11, color: "var(--ink-2)" }}>No binders yet.</p>
          )}
        </div>

        {editing && (
          <BinderForm
            value={editing}
            busy={busy}
            onChange={setEditing}
            onCancel={() => setEditing(null)}
            onSave={onSaveBinder}
          />
        )}
      </section>

      {/* ---- Rainbow order ---- */}
      <section className="setpanel panel">
        <div className="sethead">
          <span className="hk u">Rainbow order</span>
          <span className="hv u" style={{ marginLeft: "auto", fontSize: 10 }}>
            The physical sort in both halves · resets between halves
          </span>
        </div>
        <div className="bandorder">
          {data.bands.map((b, i) => (
            <BandOrderRow
              key={b.band}
              band={b}
              first={i === 0}
              last={i === data.bands.length - 1}
              busy={busy}
              onUp={() => moveBand(i, -1)}
              onDown={() => moveBand(i, 1)}
            />
          ))}
        </div>
        <div className="hint u">
          Every band keeps its slot even at zero cards — the empty Pink band reserves its space.
        </div>
      </section>

      {/* ---- Type → band map ---- */}
      <section className="setpanel panel">
        <div className="sethead">
          <span className="hk u">Type → colour band</span>
          <span className="hv u" style={{ marginLeft: "auto", fontSize: 10 }}>
            Editing recomputes stored bands
          </span>
        </div>
        <div className="typemap">
          {data.typeMap.map((t) => (
            <label key={t.cardType} className="typerow">
              <span className="ty u">{t.cardType}</span>
              <span className="arw" aria-hidden>
                →
              </span>
              <select
                className="field"
                value={t.band}
                disabled={busy}
                onChange={(e) => onSetTypeBand(t.cardType, e.target.value)}
                aria-label={`Band for ${t.cardType}`}
              >
                {data.bands.map((b) => (
                  <option key={b.band} value={b.band}>
                    {b.displayName}
                  </option>
                ))}
              </select>
              <BandChip bandKey={t.band} />
            </label>
          ))}
        </div>
        <div className="hint u">
          White absorbs Colorless, Metal, and every Trainer / Supporter / Item.
        </div>
      </section>
    </div>
  );
}

function BandOrderRow(props: {
  band: BandRow;
  first: boolean;
  last: boolean;
  busy: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  const { band, first, last, busy, onUp, onDown } = props;
  return (
    <div className="bandrow">
      <span className="pos u">{band.position}</span>
      <BandChip bandKey={band.band} label />
      <div className="ord">
        <button className="iconbtn" onClick={onUp} disabled={first || busy} aria-label="Move up">
          ▲
        </button>
        <button className="iconbtn" onClick={onDown} disabled={last || busy} aria-label="Move down">
          ▼
        </button>
      </div>
    </div>
  );
}

function BinderForm(props: {
  value: BinderInput;
  busy: boolean;
  onChange: (v: BinderInput) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { value, busy, onChange, onCancel, onSave } = props;
  return (
    <div className="binderform plate">
      <div className="ff">
        <label className="fld">
          <span className="fl u">Name</span>
          <input
            className="field"
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            placeholder="e.g. Binder 2"
          />
        </label>
        <label className="fld">
          <span className="fl u">Type</span>
          <select
            className="field"
            value={value.type}
            onChange={(e) =>
              onChange({ ...value, type: e.target.value === "specialty" ? "specialty" : "general" })
            }
          >
            <option value="general">General</option>
            <option value="specialty">Specialty</option>
          </select>
        </label>
        <label className="fld sm">
          <span className="fl u">Pages</span>
          <input
            className="field"
            type="number"
            min={0}
            value={value.pages}
            onChange={(e) => onChange({ ...value, pages: Number(e.target.value) })}
          />
        </label>
        <label className="fld sm">
          <span className="fl u">Pockets/page</span>
          <input
            className="field"
            type="number"
            min={1}
            value={value.pocketsPerPage}
            onChange={(e) => onChange({ ...value, pocketsPerPage: Number(e.target.value) })}
          />
        </label>
        {value.type === "general" && (
          <label className="fld sm">
            <span className="fl u">Back half from page</span>
            <input
              className="field"
              type="number"
              min={1}
              value={value.backHalfStartPage ?? ""}
              onChange={(e) =>
                onChange({
                  ...value,
                  backHalfStartPage: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
          </label>
        )}
        <label className="fld chk">
          <input
            type="checkbox"
            checked={value.isActive}
            onChange={(e) => onChange({ ...value, isActive: e.target.checked })}
          />
          <span className="fl u">Active binder</span>
        </label>
      </div>
      <div className="ffbtns">
        <button className="btn u" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn-primary u"
          onClick={onSave}
          disabled={busy || !value.name.trim()}
        >
          {busy ? "Saving…" : "Save binder"}
        </button>
      </div>
    </div>
  );
}
