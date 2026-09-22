import { defineConfig } from '@vscode/test-cli';

/**
 * user-data-dir 默认落在 .vscode-test/ 下。VS Code 会在里面建一个 unix domain socket,
 * 而 socket 路径有 103 字符的硬上限——在 git worktree(路径本来就深)或任何嵌套目录里
 * 跑集成测试会直接 EINVAL 启动失败,报错信息还不会告诉你是路径长度的问题。
 * 设 VSCODE_TEST_USER_DATA_DIR=/tmp/rp-ud 就能绕开。
 */
const userDataDir = process.env.VSCODE_TEST_USER_DATA_DIR;

export default defineConfig({
  files: 'out-test/test/integration/**/*.test.js',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
  launchArgs: userDataDir ? [`--user-data-dir=${userDataDir}`] : [],
});
