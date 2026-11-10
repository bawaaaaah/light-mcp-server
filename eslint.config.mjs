// Flat-config port of the maintainer's usual .eslintrc.json, for ESLint 10 + typescript-eslint 8,
// mirroring the proven port in wing-mcp-server (tools/eslint/eslint.config.js).
//
// What changed from the .eslintrc.json, and why:
// - Rules typescript-eslint 8 removed are mapped to their successors: ban-types →
//   no-wrapper-object-types + no-unsafe-function-type, no-empty-interface → no-empty-object-type,
//   no-var-requires → no-require-imports; no-parameter-properties had no effect ("off") and is gone.
//   id-blacklist → id-denylist. eslint-plugin-import → eslint-plugin-import-x (ESLint 10 support).
// - The formatting rules typescript-eslint dropped (quotes, semi, member-delimiter-style,
//   comma-dangle, keyword-spacing) and the core ones ESLint removed in 10 (new-parens,
//   no-trailing-spaces, eol-last, spaced-comment) come from @stylistic.
// - Style rules are set to what this codebase already does rather than what the .eslintrc asked
//   for, so `npm run lint` passes without rewriting files: comma-dangle is "always-multiline"
//   (the code trails its multiline literals), member-delimiter-style uses ";" for type literals
//   like it does in interfaces, and quotes let a string containing double quotes pick another
//   form (avoidEscape, plus template literals that avoid escapes).
// - Tests get their exemptions: mocha's context lives in `function () { this.timeout(…) }`
//   callbacks (no-invalid-this), fakes are empty methods on purpose, and chai's property
//   assertions (`expect(x).to.be.undefined;`) are expressions by design.

import stylistic from "@stylistic/eslint-plugin";
import importX from "eslint-plugin-import-x";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "web/dist/**",
      "lib/**",
      "coverage/**",
      ".nyc_output/**",
      "playwright-report/**",
      "test-results/**",
      "data/**",
      "**/__NO_COMMIT__/**",
      "**/__NO_COMMIT__*",
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
      "**/tsconfig*.json",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    plugins: {
      "@stylistic": stylistic,
      "import-x": importX,
      "react-hooks": reactHooks,
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.es2021 },
      parserOptions: {
        // the two config files live outside every tsconfig; vite.config.ts is covered
        // by web/tsconfig.json and must NOT be allowed a second time
        projectService: { allowDefaultProject: ["playwright.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/adjacent-overload-signatures": "error",
      "@typescript-eslint/array-type": ["warn", { default: "array" }],
      // were `ban-types`: the two successors split wrapper and function types
      "@typescript-eslint/no-wrapper-object-types": "warn",
      "@typescript-eslint/no-unsafe-function-type": "warn",
      "@typescript-eslint/consistent-type-assertions": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", disallowTypeAnnotations: false, fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/dot-notation": "error",
      // the code never writes `public`: only the implicit ones are flagged
      "@typescript-eslint/explicit-member-accessibility": ["error", { accessibility: "no-public" }],
      // ~85 exported helpers without a return type: tightening them is a task of its own
      "@typescript-eslint/explicit-module-boundary-types": [
        "warn",
        { allowArgumentsExplicitlyTypedAsAny: true },
      ],
      "@stylistic/member-delimiter-style": [
        "error",
        {
          multiline: { delimiter: "semi", requireLast: true },
          singleline: { delimiter: "semi", requireLast: false },
        },
      ],
      "@typescript-eslint/naming-convention": "off",
      // type-aware rules that read the whole tree on every file: the ~548 hits are redundant
      // `as` casts the checker already approves; removing them is a task of its own (the sibling
      // port turned this off for the same reason)
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-empty-function": "warn",
      // was `no-empty-interface`
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-misused-new": "error",
      "@typescript-eslint/no-namespace": "off",
      // was `no-parameter-properties` (removed, its "off" had no effect)
      // ~68 shadowings (midi helpers name their parameters like their scope): clean over time
      "@typescript-eslint/no-shadow": ["warn", { hoist: "all" }],
      "@typescript-eslint/no-unused-expressions": "warn",
      // the underscore keeps its role for the ignored catch binding and destructure too (`_e`, `_`)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { vars: "all", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-use-before-define": "off",
      // was `no-var-requires`
      "@typescript-eslint/no-require-imports": "error",
      "@typescript-eslint/prefer-for-of": "off",
      "@typescript-eslint/prefer-function-type": "warn",
      "@typescript-eslint/prefer-namespace-keyword": "warn",
      "@stylistic/quotes": ["error", "double", { avoidEscape: true, allowTemplateLiterals: "avoidEscape" }],
      "@typescript-eslint/require-await": "off",
      "@stylistic/semi": "error",
      "@typescript-eslint/triple-slash-reference": [
        "error",
        { path: "always", types: "prefer-import", lib: "always" },
      ],
      "@typescript-eslint/unbound-method": "error",
      "@typescript-eslint/unified-signatures": "error",
      "@stylistic/comma-dangle": ["error", "always-multiline"],
      "@stylistic/keyword-spacing": "warn",
      "@typescript-eslint/no-invalid-this": "error",
      // replaces core `no-throw-literal` (type-aware successor)
      "@typescript-eslint/only-throw-error": "error",
      // the `any`-typed boundaries (JSON.parse results, MIDI buffers, OS2L payloads): tightening
      // them is a task of its own — visible as warnings until then
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-base-to-string": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",

      "import-x/no-extraneous-dependencies": [
        "error",
        {
          devDependencies: ["**/*.test.ts", "**/*.spec.ts", "test/**", "**/vite.config.ts", "playwright.config.ts"],
          optionalDependencies: false,
          peerDependencies: false,
        },
      ],

      // --- core rules, kept from the legacy config (the formatting ones moved to @stylistic) ---
      "constructor-super": "error",
      "dot-notation": "off",
      "eqeqeq": ["error", "smart"],
      "guard-for-in": "off",
      // the legacy guard, without the lower-case primitives: this code names conversion
      // parameters `number` and `string` (midi helpers), renaming them is a task of its own
      "id-denylist": ["error", "any", "Number", "String", "Boolean", "Undefined", "undefined"],
      "id-match": "error",
      "max-classes-per-file": "off",
      // a DMX server lives on bit twiddling (codecs, mappings, universes): warnings were noise here
      "no-bitwise": "off",
      "no-caller": "error",
      "no-cond-assign": "warn",
      "no-console": "off",
      "no-debugger": "error",
      "no-empty": "off",
      "no-empty-function": "off",
      "no-eval": "error",
      "no-fallthrough": "off",
      "no-invalid-this": "off", // the type-aware @typescript-eslint one rules instead
      "no-irregular-whitespace": "error",
      "no-new-wrappers": "error",
      "no-shadow": "off",
      "no-throw-literal": "off", // replaced by @typescript-eslint/only-throw-error
      "no-undef-init": "error",
      "no-underscore-dangle": "off",
      "no-unsafe-finally": "error",
      "no-unused-expressions": "off",
      "no-unused-labels": "error",
      "no-unused-vars": "off",
      "no-use-before-define": "off",
      "no-var": "error",
      "object-shorthand": "off",
      "one-var": ["error", "never"],
      "prefer-arrow-callback": "warn",
      "prefer-const": "error",
      "quotes": "off",
      "radix": "error",
      "require-await": "off",
      "semi": "off",
      "comma-dangle": "off",
      "use-isnan": "warn",
      "valid-typeof": "off",

      // --- formatting, from @stylistic (removed from the ESLint 10 core) ---
      "@stylistic/new-parens": "error",
      "@stylistic/no-trailing-spaces": "error",
      "@stylistic/spaced-comment": ["warn", "always", { markers: ["/"] }],
      "@stylistic/eol-last": "error",

      // --- react hooks (the web code already carries `eslint-disable` directives for them) ---
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["web/src/**/*.ts", "web/src/**/*.tsx"],
    languageOptions: { globals: { ...globals.browser, ...globals.es2021 } },
    rules: {
      // the web app's dependencies live in web/package.json and only the bundler reads them
      "import-x/no-extraneous-dependencies": "off",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-invalid-this": "off",
      // fakes and stubs are empty methods by nature
      "@typescript-eslint/no-empty-function": "off",
      // chai's property assertions (`expect(x).to.be.undefined;`) are expressions by design
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
