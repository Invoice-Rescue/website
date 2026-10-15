import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

const downgradeToWarn = (rules) => {
  if (!rules) return rules;
  return Object.fromEntries(
    Object.entries(rules).map(([key, val]) => {
      if (val === 'error') return [key, 'warn'];
      if (Array.isArray(val) && val[0] === 'error') return [key, ['warn', ...val.slice(1)]];
      return [key, val];
    })
  );
};

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'dist/**',
      'build/**',
      'coverage/**',
      '.wrangler/**',
      '.agents/**',
      '.claude/**',
      '.claude-flow/**',
      '.swarm/**',
      'playwright-report/**',
      'test-results/**',
      'graphify-out/**',
      'worker-configuration.d.ts',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },

  // Apply strict type-checked rules to TypeScript files
  ...tseslint.configs.strictTypeChecked.map((config) => {
    const newConfig = { ...config, files: ['**/*.{ts,tsx}'] };
    if (config.rules) {
      newConfig.rules = downgradeToWarn(config.rules);
    }
    return newConfig;
  }),

  // Stylistic type-aware rules (optional, highly recommended)
  ...tseslint.configs.stylisticTypeChecked.map((config) => {
    const newConfig = { ...config, files: ['**/*.{ts,tsx}'] };
    if (config.rules) {
      newConfig.rules = downgradeToWarn(config.rules);
    }
    return newConfig;
  }),

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        // Automatically discovers tsconfig project references without manual paths
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // No React/Tailwind in this repo (vanilla Worker + static HTML), so those
    // plugins were dropped — they also pinned eslint <10 and blocked npm audit fixes.
    plugins: {
      'unused-imports': unusedImports,
    },
    rules: {
      // Catch unhandled async promises (prevents silent agent runtime failures)
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/await-thenable': 'warn',

      // Prevent unsafe type leakage
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',

      // Relax strict rules that often produce false positives for common patterns
      '@typescript-eslint/restrict-template-expressions': [
        'warn',
        { allowNumber: true, allowBoolean: true },
      ],

      // Unused imports handling
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Disable typed rules for standard JS config files (e.g., eslint.config.mjs itself)
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },

  prettierConfig // Must stay last to deactivate conflicting stylistic rules
);
