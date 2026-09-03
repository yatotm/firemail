import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { firemailPlugin } from './tools/eslint/no-raw-form-elements.js';

/**
 * 从第一天就把 lint 立起来。上游项目开着 `eslint.ignoreDuringBuilds`，
 * 攒到 164 条告警才回头做一个专门的清理项目 —— 这里不给它机会。
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  jsxA11y.flatConfigs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2023 },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // shadcn 的约定就是组件与它的 cva variants 同文件导出，这两个是白名单
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true, allowExportNames: ['buttonVariants', 'badgeVariants'] },
      ],

      // 硬性要求：不许有 any
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 事件处理里写 `void promise` 比 `.catch(noop)` 更直白
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: true, ignoreVoidOperator: true },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false, allowNullish: false },
      ],
    },
  },

  /**
   * 表单基元的护栏：原生 input / select / textarea 只允许出现在 components/ui 里。
   * 见 tools/eslint/no-raw-form-elements.js。
   */
  {
    files: ['src/**/*.tsx'],
    ignores: ['src/components/ui/**'],
    plugins: { firemail: firemailPlugin },
    rules: { 'firemail/no-raw-form-elements': 'error' },
  },

  {
    files: ['**/*.test.{ts,tsx}', 'src/lib/test/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  {
    files: ['*.config.{js,ts}', 'eslint.config.js', 'tools/**/*.js'],
    languageOptions: { globals: globals.node },
    ...tseslint.configs.disableTypeChecked,
  },
);
