/**
 * Generates the PWA / home-screen icons into public/ from the app's retro
 * palette (app/globals.css). Deterministic and reproducible — re-run with
 * `node scripts/gen-icons.mjs` after a palette change. These are a clean,
 * on-brand placeholder mark (a note-tabbed binder card on the olive field);
 * swap in real artwork later without touching the manifest wiring.
 */
import { PNG } from "pngjs";
import { writeFileSync, mkdirSync } from "node:fs";

const OLIVE = [0x6d, 0x7b, 0x3c]; // --olive (app field / theme color)
const PANEL = [0xfb, 0xf2, 0xdd]; // --panel (card face)
const INK = [0x3c, 0x3c, 0x3b]; // --ink (border)
const NOTE = [0xfe, 0xdf, 0x4f]; // --note (tab strip)

/**
 * Draw a size×size RGBA PNG: olive field, a centered "card" (panel + ink
 * border) with a note-yellow tab. `maskable` insets the card into the safe
 * zone so platform masking never clips it.
 */
function icon(size, { maskable }) {
  const png = new PNG({ width: size, height: size });
  const inset = maskable ? 0.3 : 0.22;
  const cardLo = Math.round(size * inset);
  const cardHi = size - cardLo;
  const border = Math.max(2, Math.round(size * 0.02));
  const tab = Math.round(size * 0.14);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = OLIVE;
      const inCard = x >= cardLo && x < cardHi && y >= cardLo && y < cardHi;
      if (inCard) {
        const onBorder =
          x < cardLo + border ||
          x >= cardHi - border ||
          y < cardLo + border ||
          y >= cardHi - border;
        if (onBorder) c = INK;
        else if (y < cardLo + border + tab) c = NOTE;
        else c = PANEL;
      }
      const i = (size * y + x) << 2;
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = 0xff;
    }
  }
  return PNG.sync.write(png);
}

mkdirSync("public", { recursive: true });
const outputs = [
  ["public/icon-192.png", 192, false],
  ["public/icon-512.png", 512, false],
  ["public/icon-maskable-512.png", 512, true],
  ["public/apple-touch-icon.png", 180, false],
];
for (const [path, size, maskable] of outputs) {
  writeFileSync(path, icon(size, { maskable }));
  console.log(`wrote ${path} (${size}×${size}${maskable ? ", maskable" : ""})`);
}
