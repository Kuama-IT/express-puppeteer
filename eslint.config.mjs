import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import tseslint from "typescript-eslint";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
    baseDirectory: __dirname,
});

const eslintConfig = [
    ...compat.extends("prettier"),
    { files: ["**/*.js"], languageOptions: { sourceType: "commonjs" } },
    { files: ["src/**/*.ts"] },
    ...tseslint.configs.recommended,
];

export default eslintConfig;
