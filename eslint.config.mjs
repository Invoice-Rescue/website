import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import unusedImports from 'eslint-plugin-unused-imports';
import tailwind from 'eslint-plugin-tailwindcss';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['node_modules/**', '.next/**', 'dist/**', 'build/**', 'coverage/**'],
  },
  js.configs.recommended,
  
  // Apply strict type-checked rules to TypeScript files
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}'],
  })),

  // Stylistic type-aware rules (optional, highly recommended)
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}'],
  })),

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        // Automatically discovers tsconfig project references without manual paths
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'unused-imports': unusedImports,
    },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      
      // Catch unhandled async promises (prevents silent agent runtime failures)
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // Prevent unsafe type leakage
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',

      // Relax strict rules that often produce false positives for common patterns
      '@typescript-eslint/restrict-template-expressions': [
        'error',
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

  // Spread Tailwind flat config presets
  ...[tailwind.configs['flat/recommended'] || tailwind.configs.recommended],

  {
    files: ['**/*.{jsx,tsx}'],
    settings: {
      tailwindcss: {
        // Enforce sorting inside class merge utilities like clsx, cva, and cn
        callees: ['classnames', 'clsx', 'ctl', 'cva', 'cn', 'twMerge'],
        config: 'tailwind.config.js',
      },
    },
    rules: {
      // Auto-fixes class ordering on save / --fix
      'tailwindcss/classnames-order': 'warn',

      // Warns against non-existent Tailwind classes or typos
      'tailwindcss/no-custom-classname': 'warn',

      // Recommends shorthand alternatives (e.g., px-2 py-2 -> p-2)
      'tailwindcss/enforces-shorthand': 'warn',

      // Warns on conflicting declarations (e.g., p-2 p-4)
      'tailwindcss/no-contradicting-classname': 'error',
    },
  },

  prettierConfig // Must stay last to deactivate conflicting stylistic rules
);
