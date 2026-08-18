// Flat ESLint config for every workspace. Type-aware rules are deliberately
// left off: `tsc --noEmit` already runs in CI for each package and covers what
// they would add, without the cost of a second full type-check.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "packages/web/dist/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/{api,worker,shared}/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["packages/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "jsx-a11y": jsxA11y, "react-hooks": reactHooks },
    rules: {
      ...jsxA11y.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // autoFocus is deliberate on the OTP and share inputs: both are
      // single-purpose fields on a view the user opened to type into them,
      // which is the case the rule's own docs carve out.
      "jsx-a11y/no-autofocus": "off",
    },
  },
  {
    rules: {
      // Unused values are usually a leftover from an edit; allow the
      // conventional _-prefix to mark one as intentional.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Floating promises are the failure mode that actually bites here
      // (fire-and-forget DB writes), but catching them needs type info, so
      // require the explicit `void` marker the codebase already uses.
      "no-console": "off",
    },
  }
);
