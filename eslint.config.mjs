// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'out-test/**', 'node_modules/**', '.vscode-test/**', '*.vsix'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 类型感知规则只跑 src:每条规则都要为文件建 TS Program,把 test/ 也拉进来会让
    // project service 反复推断整张依赖图,在本机直接 OOM。测试由 tsc + node --test 兜底。
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 采集器/调度器的 catch 块普遍只做降级返回,不强制引用 err。
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
);
