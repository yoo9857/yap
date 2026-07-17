import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "legacy/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.config.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // dev/e2e scripts: node + puppeteer-evaluated browser code in one file,
    // exercised by running them — static no-undef only produces noise here
    files: ["tools/**/*.mjs"],
    rules: { "no-undef": "off" },
  },
);
