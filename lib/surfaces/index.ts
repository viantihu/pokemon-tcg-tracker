/**
 * M8 surfaces — pure logic for Lookup · Wishlist · Collections · Capacity · Settings (dev-spec §5 M8).
 *
 * These modules are I/O-free (like `lib/engine` and `lib/plan`'s pure half): DB/joined rows in,
 * display shapes + decisions out. The route-group server actions do the I/O and call in here, which
 * keeps the show-floor lookup, the CSV round-trip, the band recompute, and the placement-picker
 * contract all unit-testable without a browser or a DB.
 */

export * from "./lookup";
export * from "./wishlist";
export * from "./recompute";
export * from "./collections";
export * from "./capacity";
