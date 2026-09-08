/**
 * M3 placement engine — public surface.
 *
 * Pure, I/O-free placement logic (system-design §3, §5, §6; dev-spec §5 M3). Import from here rather
 * than the individual modules. All functions take catalog/copy records as inputs and return
 * decisions; the clock and market prices are injected.
 */

export * from "./types";
export * from "./bands";
export * from "./duplicate";
export * from "./line";
export * from "./cascade";
