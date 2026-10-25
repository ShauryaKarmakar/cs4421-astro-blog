import eslintPluginAstro from "eslint-plugin-astro"
import tseslint from "typescript-eslint";

export default [
    ...tseslint.configs.recommended,
    ...eslintPluginAstro.configs["flat/recommended"],
    {
        ignores: [".astro/**", "**/cdk.out/**", "dist/**", "dist-static/**", "node_modules/**"],
    },
    {
        rules: {
            "@typescript-eslint/no-unused-vars": "error",
            "no-console": "warn",
        },
    },
]