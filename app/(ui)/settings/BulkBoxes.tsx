"use client";

/**
 * Settings · Bulk boxes (UIL-130). Karvi, 2026-09-29: several bulk boxes, added like binders, each with a name; a box
 * may have a card limit or none (a new box starts with none); a box with a limit that is full takes no more; her first
 * box is "Bulk box". She always has exactly one default box (where a card goes when she names none). A box is deleted
 * only with somewhere for its cards to go, and never her last one; the database refuses either in her words.
 */

import { useState } from "react";
import { boxLoad } from "@/lib/plan/bulk-units";
import type { BulkUnitInput, BulkUnitRow } from "./settings-types";

export { boxLoad };

const BLANK: BulkUnitInput = { id: null, name: "", capacity: null };

export function BulkBoxes({
  units,
  busy,
  onSave,
  onMakeDefault,
  onDelete,
}: {
  units: BulkUnitRow[];
  busy: boolean;
  onSave(input: BulkUnitInput): Promise<boolean>;
  onMakeDefault(id: string): void;
  onDelete(id: string, moveTo: string): Promise<boolean>;
}) {
  const [editing, setEditing] = useState<BulkUnitInput | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; moveTo: string } | null>(null);
  const only = units.length <= 1;

  return (
    <section className="setpanel panel" aria-label="Bulk boxes">
      <div className="sethead">
        <span className="hk u">Bulk boxes</span>
        <button
          className="btn u"
          style={{ marginLeft: "auto" }}
          onClick={() => {
            setDeleting(null);
            setEditing({ ...BLANK });
          }}
          disabled={busy}
        >
          ＋ New box
        </button>
      </div>
      <div className="binderlist">
        {units.map((u) => (
          <div key={u.id} className="binderrow" data-box={u.id}>
            <div style={{ minWidth: 0 }}>
              <div className="nm u">
                {u.name}
                {u.isDefault ? (
                  <span className="tag" style={{ marginLeft: 8 }}>
                    DEFAULT
                  </span>
                ) : null}
              </div>
              <div className="meta u">{boxLoad(u)}</div>
            </div>
            {u.isDefault ? null : (
              <button className="editcollbtn u" onClick={() => onMakeDefault(u.id)} disabled={busy}>
                Make default
              </button>
            )}
            <button
              className="editcollbtn u"
              onClick={() => {
                setDeleting(null);
                setEditing({ id: u.id, name: u.name, capacity: u.capacity });
              }}
              disabled={busy}
              aria-label={`Edit ${u.name}`}
            >
              ✎ Edit
            </button>
            <button
              className="editcollbtn u"
              onClick={() => {
                setEditing(null);
                setDeleting({ id: u.id, moveTo: units.find((o) => o.id !== u.id)?.id ?? "" });
              }}
              disabled={busy || only}
              aria-label={`Delete ${u.name}`}
              title={
                only ? "Your only bulk box. Add another box before you delete this one." : undefined
              }
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      {only ? (
        <div className="hint u">
          Your only bulk box can&apos;t be deleted: add another box first.
        </div>
      ) : null}

      {deleting ? (
        <DeleteBox
          unit={units.find((u) => u.id === deleting.id)!}
          others={units.filter((u) => u.id !== deleting.id)}
          moveTo={deleting.moveTo}
          busy={busy}
          onPick={(moveTo) => setDeleting({ ...deleting, moveTo })}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            if (await onDelete(deleting.id, deleting.moveTo)) setDeleting(null);
          }}
        />
      ) : null}

      {editing ? (
        <BoxForm
          value={editing}
          busy={busy}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={async () => {
            if (await onSave(editing)) setEditing(null);
          }}
        />
      ) : null}
    </section>
  );
}

/** Delete asks where its cards go (Karvi: she never loses a card); a box with a limit that cannot take them all is
 * named so before she confirms, and the database refuses it either way. */
function DeleteBox({
  unit,
  others,
  moveTo,
  busy,
  onPick,
  onCancel,
  onConfirm,
}: {
  unit: BulkUnitRow;
  others: BulkUnitRow[];
  moveTo: string;
  busy: boolean;
  onPick(id: string): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  const dest = others.find((o) => o.id === moveTo);
  const room = dest && dest.capacity !== null ? Math.max(dest.capacity - dest.held, 0) : null;
  const tooMany = room !== null && unit.held > room;
  return (
    <div className="binderform plate" role="group" aria-label={`Delete ${unit.name}`}>
      <p style={{ fontSize: 12, lineHeight: 1.6 }}>
        Delete <b>{unit.name}</b>?{" "}
        {unit.held > 0
          ? `Its ${unit.held} card${unit.held === 1 ? "" : "s"} go to:`
          : "It holds no cards. Anything that calls it home goes to:"}
      </p>
      <label className="fld">
        <span className="fl u">Move its cards to</span>
        <select
          className="field"
          value={moveTo}
          onChange={(e) => onPick(e.target.value)}
          aria-label="Move its cards to"
        >
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} · {boxLoad(o)}
            </option>
          ))}
        </select>
      </label>
      {unit.isDefault && dest ? (
        <div className="hint u">{dest.name} becomes your default box.</div>
      ) : null}
      {tooMany && dest ? (
        <div className="hint u" role="alert">
          {dest.name} has room for {room} card{room === 1 ? "" : "s"}. Pick another box, or raise
          its limit first.
        </div>
      ) : null}
      <div className="ffbtns">
        <button className="btn u" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn-primary u"
          onClick={onConfirm}
          disabled={busy || !dest || tooMany}
        >
          {busy ? "Deleting…" : `Delete ${unit.name}`}
        </button>
      </div>
    </div>
  );
}

function BoxForm({
  value,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  value: BulkUnitInput;
  busy: boolean;
  onChange(v: BulkUnitInput): void;
  onCancel(): void;
  onSave(): void;
}) {
  const limited = value.capacity !== null;
  // What she is typing, kept as typed (an empty box while she clears it, not a number forced in).
  const [raw, setRaw] = useState(value.capacity === null ? "" : String(value.capacity));
  return (
    <div className="binderform plate" role="group" aria-label={value.id ? "Edit box" : "New box"}>
      <div className="ff">
        <label className="fld">
          <span className="fl u">Name</span>
          <input
            className="field"
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            placeholder="e.g. Shoebox"
          />
        </label>
        <label className="fld chk">
          <input
            type="checkbox"
            checked={limited}
            onChange={(e) => {
              setRaw(e.target.checked ? "100" : "");
              onChange({ ...value, capacity: e.target.checked ? 100 : null });
            }}
          />
          <span className="fl u">Card limit</span>
        </label>
        {limited ? (
          <label className="fld sm">
            <span className="fl u">Cards it holds</span>
            <input
              className="field"
              type="number"
              min={1}
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                // Not a whole number of 1 or more yet: 0, which Save refuses until it is one.
                const n = Number(e.target.value);
                onChange({ ...value, capacity: Number.isInteger(n) && n >= 1 ? n : 0 });
              }}
            />
          </label>
        ) : null}
      </div>
      <div className="hint u">
        {limited
          ? "When it's full it takes no more, and you'll be asked for another box."
          : "No limit: it's never full."}
      </div>
      <div className="ffbtns">
        <button className="btn u" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn-primary u"
          onClick={onSave}
          disabled={busy || !value.name.trim() || (limited && !((value.capacity ?? 0) >= 1))}
        >
          {busy ? "Saving…" : "Save box"}
        </button>
      </div>
    </div>
  );
}
