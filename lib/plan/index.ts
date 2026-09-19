/**
 * M6 haul-intake + placement-plan — public surface (dev-spec §5 M6).
 *
 * Pure logic (types, action mapping, grouping, placement, adapters) plus the I/O orchestration
 * (context load, cascade run, commit). Import from here.
 */

export * from "./types";
export * from "./action";
export * from "./group";
export * from "./placement";
export * from "./assemble";
export * from "./adapt";
export * from "./context";
export * from "./commit";
export * from "./pending";
export * from "./catalog-cache";
export * from "./fingerprint";
export * from "./progress";
export * from "./spotlight";
export * from "./line-join";
export { getOwnerContext, SEEDED_OWNER_ID, type OwnerContext } from "./session";
