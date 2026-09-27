"use client";

/**
 * Escape closes the TOP layer only (UIL-117: the line popup can open over the Move sheet, which can open over a
 * replace, which sits over the Lines page). Each open layer pushes its close handler; one window capture listener
 * runs the top one and stops the key there, so the layers underneath (and a sheet's own document listener, and the
 * Collections editor's window listener) never see it. With no layer open, Escape behaves as before.
 */

import { useEffect, useRef } from "react";

const stack: { current: () => void }[] = [];

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || stack.length === 0) return;
  e.stopPropagation();
  stack[stack.length - 1].current();
}

/** While `active`, Escape runs `onEscape` (and nothing beneath it). Layers opened later sit on top. */
export function useEscapeLayer(active: boolean, onEscape: () => void): void {
  const handler = useRef(onEscape);
  useEffect(() => {
    handler.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    const layer = { current: () => handler.current() };
    stack.push(layer);
    if (stack.length === 1) window.addEventListener("keydown", onKey, true);
    return () => {
      const i = stack.indexOf(layer);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) window.removeEventListener("keydown", onKey, true);
    };
  }, [active]);
}
