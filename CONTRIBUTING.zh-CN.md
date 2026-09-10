# 贡献指南

[English](CONTRIBUTING.md) | **简体中文**

本地构建与运行请见 README 的 [开发](README.zh-CN.md#开发) 一节。本文档只覆盖 CI/发布流水线,以及实现自动发布所需的一次性仓库配置。

## CI / 发布流水线

仓库里配了四个 workflow(`.github/workflows/`):

| Workflow | 触发条件 | 作用 |
|---|---|---|
| `ci.yml` | 每次 push / PR 到 `main` | `npm ci` → 编译 → 单元测试 → 集成测试(真实 VS Code 扩展宿主)→ `vsce package` → 把 `.vsix` 传成 workflow artifact、同时发布成一个 `pr-<N>` 的 prerelease,并在 PR 里评论一条一键安装命令 |
| `pr-cleanup.yml` | PR 被关闭 | 删掉该 PR 对应的 `pr-<N>` prerelease 和 tag,避免 Releases 列表堆满测试版本 |
| `release-please.yml` | push 到 `main` | 根据 [Conventional Commits](https://www.conventionalcommits.org/) 提交信息,自动维护一个"Release PR"(更新 `package.json` 版本号 + `CHANGELOG.md`);合并该 PR 后自动打 tag、建 GitHub Release——用的是一个 PAT(见下文),这样建出来的 Release 才能继续触发 `publish.yml` |
| `publish.yml` | GitHub Release 发布(`release: published`),prerelease 会被跳过 | 编译 → 测试 → 打包 `.vsix` → 附加到 Release → 发布到 VS Code Marketplace(`vsce publish`)与 Open VSX(`ovsx publish`) |

### 拿到某个 PR 的测试版本

每个 PR 下面都会有一条评论,带一条能直接执行的安装命令,比如:

```bash
curl -fL -o remote-pulse-pr-8.vsix "https://github.com/tzzs/remote-pulse/releases/download/pr-8/remote-pulse-pr-8.vsix" && code --install-extension remote-pulse-pr-8.vsix
```

这个测试版本是一个标成 prerelease 的 GitHub Release(不会顶替"Latest"那个正式版,正式版还是 release-please 打的),每次给这个 PR 推送新提交都会覆盖它,PR 关闭后会自动删除。

也就是说完整链路是:**日常提交遵循 Conventional Commits(`feat: xxx` / `fix: xxx` / `chore: xxx` …)→ release-please 开出版本 PR → 合并后自动发 GitHub Release → 自动推送到两个插件市场**。

### 一次性手动准备(仓库 Secrets)

要让完整链路(release-please → GitHub Release → 两个市场)跑通,需要先手动完成以下准备(仅需一次):

1. **VS Code Marketplace**:在 [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) 注册一个 publisher(需确认与 `package.json` 里的 `"publisher": "tanzz"` 一致,或改成你实际注册的 publisher id),再在 Azure DevOps 生成一个 **Marketplace (Manage)** 权限的 PAT。
2. **Open VSX**:在 [open-vsx.org](https://open-vsx.org) 用 Eclipse 账号登录,认领与 publisher 同名的 namespace(`npx ovsx create-namespace tanzz -p <token>` 或网页操作),再生成一个 access token。
3. **release-please 用的 GitHub PAT**:用默认 `GITHUB_TOKEN` 建出来的 Release 没法触发另一个 workflow——这是 GitHub 自带的防循环规则——所以 `release-please.yml` 需要一个自己的 PAT(classic PAT 勾 `repo` 权限,或 fine-grained PAT 勾 `Contents: write` + `Pull requests: write`),这样它建出来的 Release 才能继续触发 `publish.yml`。
4. 把三个 token 都写入仓库 Secrets(建议在自己终端执行,不要把 token 贴进聊天):
   ```bash
   gh secret set VSCE_PAT --repo tzzs/remote-pulse
   gh secret set OVSX_PAT --repo tzzs/remote-pulse
   gh secret set RELEASE_PLEASE_TOKEN --repo tzzs/remote-pulse
   ```

`RELEASE_PLEASE_TOKEN` 没配置好之前,release-please 自己开的 PR/Release 根本不会触发 `publish.yml`;`VSCE_PAT`/`OVSX_PAT` 没配置好之前,`publish.yml` 会跑起来但在 Marketplace/Open VSX 发布这两步失败(编译、测试、打包、上传 `.vsix` 到 Release 仍然成功)。这两种情况在准备完成之前都属于预期行为。
