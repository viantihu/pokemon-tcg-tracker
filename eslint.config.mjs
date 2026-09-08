import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Claude Code scratch space: local settings + agent worktrees (each a full checkout with its
    // own build output). Never project source — must not be linted. The root ".next/**" above is
    // anchored, so nested "**/.next" under a worktree would otherwise slip through.
    ".claude/**",
  ]),
]);

export default eslintConfig;
