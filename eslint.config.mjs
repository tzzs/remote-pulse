import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * 扁平配置(ESLint 9)。三类代码各有各的运行环境:
 * - src/、test/ 是 Node 上跑的 TypeScript
 * - media/ 是在 webview(浏览器)里跑的 ES module,没有 require/process,但有 document/window
 * 之前 .vscodeignore 里写了 .eslintrc* 却从来没有配置文件,CI 也只跑 build/test——
 * webview 那 500 行脚本因为塞在模板字符串里,连语法错都要等运行时才暴露。
 */
export default [
  {
    ignores: ['out/**', 'out-test/**', 'node_modules/**', '.vscode-test/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map(config => ({ ...config, files: ['src/**/*.ts', 'test/**/*.ts'] })),
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    files: ['media/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        document: 'readonly',
        window: 'readonly',
        acquireVsCodeApi: 'readonly',
        Date: 'readonly',
        Math: 'readonly',
        JSON: 'readonly',
        isFinite: 'readonly',
        isNaN: 'readonly',
        Infinity: 'readonly',
      },
    },
  },
  {
    files: ['test/**/*.mjs', '*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { process: 'readonly' } },
  },
];
