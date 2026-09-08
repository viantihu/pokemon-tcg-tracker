/**
 * M7 line detail + decision cards + placement override — public surface (dev-spec §5 M7).
 *
 * Pure view-model + decision + move logic, plus the I/O orchestration that loads persisted line
 * state and applies confirms / overrides / moves through `lib/repo`. Import from here.
 */

export * from "./types";
export * from "./view";
export * from "./decisions";
export * from "./move";
export * from "./load";
export * from "./write";
