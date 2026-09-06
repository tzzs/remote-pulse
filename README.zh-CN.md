# Remote Pulse(远程脉搏)

[English](README.md) | **简体中文**

<p align="center">
  <img src="images/icon.png" width="96" height="96" alt="Remote Pulse icon" />
</p>

以 VSCode 原生延迟指示器般"安静但随时可查"的方式,持续感知 Remote-SSH 远程主机的 CPU / 内存 / 磁盘 / 网络 / GPU / Docker 状态,不打断编码心流。

## 为什么是 Remote Pulse

市面上的同类插件多是把仪表盘搬进状态栏,信息密度高、常驻显示重。Remote Pulse 的差异化:

| 维度 | 现有插件普遍做法 | Remote Pulse |
|---|---|---|
| 常驻信息量 | CPU\|MEM\|DISK 全部平铺 | 默认只有 1 个 icon + 1 个核心数字,其余进 tooltip |
| 视觉基调 | 数值常态化配色 | 默认中性色,仅越阈值才变色告警 |
| 交互 | 部分需开侧边栏 | 点击弹出轻量 Webview,不占用常驻空间,关闭不留痕迹 |
| 资源开销 | 部分用 spawn 子进程轮询 | 直读 `/proc`,核心指标零子进程常态开销 |
| 场景感知 | 前后台一致轮询 | 窗口失焦自动降频 |

## 效果预览

```
默认态:  $(pulse) 23%
告警态:  $(warning) 92%   ← 状态栏背景变为警告色/严重色
```

鼠标悬浮展开 tooltip:

```
远程主机: dev-gpu-01 (192.168.x.x)
─────────────────────
CPU   ▁▃▅▇▆▄▂  23%  (8 核)
内存  ▂▂▃▄▄▃▂  61%  (9.8G / 16G)
Uptime  12d 4h
─────────────────────
点击查看趋势图
```

点击状态栏弹出 30 分钟 CPU/内存趋势的折线图(Webview,关闭即销毁,不常驻内存)。

## 功能

- **CPU**:总体使用率、核心数(`/proc/stat` 增量算法,非 loadavg)
- **内存**:使用率、已用/总量(`MemAvailable` 而非 `MemFree`,更贴近真实可用内存)
- **磁盘**:各挂载点使用率(自动过滤虚拟文件系统,默认展示使用率 Top 3,或手动指定挂载点)
- **网络**:上行/下行速率(默认关闭,减少 tooltip 噪音)
- **GPU**:显存占用、利用率、温度(需要 `nvidia-smi`,不存在则模块整体不激活)
- **Docker**:运行中容器数与各容器 CPU/内存占用(需要可访问 `/var/run/docker.sock`,无权限则静默降级)
- **阈值告警**:CPU/内存超阈值时状态栏变色,可选弹出系统通知(仅在"跨越"到严重态时通知一次,避免刷屏)
- **历史趋势**:tooltip sparkline + 点击弹出的 Webview 折线图
- **自适应轮询**:窗口失焦后自动降频,减少对远程机器的干扰
- **界面本地化**:命令、设置项、状态栏/Webview 文案跟随 VS Code 显示语言自动切换(默认英文,内置简体中文翻译)

## 安装

从 [Releases](../../releases) 下载 `.vsix` 文件,在 VSCode 中执行:

```
Extensions: Install from VSIX...
```

或命令行安装:

```bash
code --install-extension remote-pulse-0.1.0.vsix
```

安装后通过 Remote-SSH 连接到 Linux 远程主机即可在状态栏看到指标(本插件声明为 `extensionKind: workspace`,会自动运行在远程 extension host 上,无需额外配置)。

## 配置项

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `remotePulse.refreshInterval` | `2000` | 前台高频指标(CPU/内存)刷新间隔(ms) |
| `remotePulse.backgroundInterval` | `15000` | 窗口失焦后的降频间隔(ms) |
| `remotePulse.heavyMetricInterval` | `10000` | GPU/Docker 等低频指标独立轮询间隔(ms) |
| `remotePulse.warningThreshold` | `80` | 告警阈值(%) |
| `remotePulse.criticalThreshold` | `95` | 严重阈值(%) |
| `remotePulse.template` | `"$(pulse) CPU ${cpu}%  MEM ${mem}%"` | 状态栏显示模板(`${cpu}` / `${mem}`) |
| `remotePulse.enableGpu` | `true` | 是否探测并展示 GPU 信息 |
| `remotePulse.enableDocker` | `true` | 是否探测并展示 Docker 容器信息 |
| `remotePulse.enableNetwork` | `false` | 是否展示网络上下行速率 |
| `remotePulse.enableNotifications` | `false` | 越过严重阈值时是否弹出系统通知 |
| `remotePulse.diskMountPoints` | `[]` | 指定要监控的挂载点,留空则自动选 Top 3 |

## 命令

- `Remote Pulse: 显示趋势图`(`remotePulse.showTrend`,也绑定在状态栏点击上)
- `Remote Pulse: 立即刷新`(`remotePulse.refresh`)

## 边界情况

- **非 Linux 远程主机**:CPU/内存自动回退到 Node.js `os` 模块(精度略低),网络模块因无跨平台等价物而直接隐藏
- **首次连接**:状态栏先显示 `$(sync~spin)` 加载态
- **采集失败**(权限/网络抖动):显示 `$(circle-slash)`,tooltip 说明原因,不弹烦人的错误通知
- **GPU/Docker 不可用**:启动时探测一次,不存在/无权限则该模块整体不激活,不反复重试

## 开发

```bash
npm install
npm run build     # tsc 编译到 out/
npm test          # 编译并运行 test/ 下的单元测试(node:test)
npm run test:integration  # 在真实 VS Code 扩展宿主里跑 test/integration/(@vscode/test-cli)
npm run package   # vsce package 生成 .vsix
```

在 VSCode 中打开本项目,按 `F5` 启动 Extension Development Host 即可实时调试(本地 macOS/Windows 环境下 CPU/内存会走 `os` 模块兜底路径,便于在没有远程 Linux 主机时也能验证核心交互)。

## CI / 发布流水线

仓库里配了四个 workflow(`.github/workflows/`):

| Workflow | 触发条件 | 作用 |
|---|---|---|
| `ci.yml` | 每次 push / PR 到 `main` | `npm ci` → 编译 → 单元测试 → 集成测试(真实 VS Code 扩展宿主)→ `vsce package` → 把 `.vsix` 传成 workflow artifact、同时发布成一个 `pr-<N>` 的 prerelease,并在 PR 里评论一条一键安装命令 |
| `pr-cleanup.yml` | PR 被关闭 | 删掉该 PR 对应的 `pr-<N>` prerelease 和 tag,避免 Releases 列表堆满测试版本 |
| `release-please.yml` | push 到 `main` | 根据 [Conventional Commits](https://www.conventionalcommits.org/) 提交信息,自动维护一个"Release PR"(更新 `package.json` 版本号 + `CHANGELOG.md`);合并该 PR 后自动打 tag、建 GitHub Release |
| `publish.yml` | GitHub Release 发布(`release: published`),prerelease 会被跳过 | 编译 → 测试 → 打包 `.vsix` → 附加到 Release → 发布到 VS Code Marketplace(`vsce publish`)与 Open VSX(`ovsx publish`) |

### 拿到某个 PR 的测试版本

每个 PR 下面都会有一条评论,带一条能直接执行的安装命令,比如:

```bash
curl -fL -o remote-pulse-pr-8.vsix "https://github.com/tzzs/remote-pulse/releases/download/pr-8/remote-pulse-pr-8.vsix" && code --install-extension remote-pulse-pr-8.vsix
```

这个测试版本是一个标成 prerelease 的 GitHub Release(不会顶替"Latest"那个正式版,正式版还是 release-please 打的),每次给这个 PR 推送新提交都会覆盖它,PR 关闭后会自动删除。

也就是说完整链路是:**日常提交遵循 Conventional Commits(`feat: xxx` / `fix: xxx` / `chore: xxx` …)→ release-please 开出版本 PR → 合并后自动发 GitHub Release → 自动推送到两个插件市场**。

### 一次性手动准备(仓库 Secrets)

自动发布到两个市场之前,需要先手动完成(仅需一次):

1. **VS Code Marketplace**:在 [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) 注册一个 publisher(需确认与 `package.json` 里的 `"publisher": "tanzz"` 一致,或改成你实际注册的 publisher id),再在 Azure DevOps 生成一个 **Marketplace (Manage)** 权限的 PAT。
2. **Open VSX**:在 [open-vsx.org](https://open-vsx.org) 用 Eclipse 账号登录,认领与 publisher 同名的 namespace(`npx ovsx create-namespace tanzz -p <token>` 或网页操作),再生成一个 access token。
3. 把两个 token 写入仓库 Secrets(建议在自己终端执行,不要把 token 贴进聊天):
   ```bash
   gh secret set VSCE_PAT --repo tzzs/remote-pulse
   gh secret set OVSX_PAT --repo tzzs/remote-pulse
   ```

在这两个 Secrets 配置好之前,`publish.yml` 会在 Marketplace/Open VSX 发布这两步失败(其余步骤——编译、测试、打包、上传 `.vsix` 到 Release——不受影响),属于预期行为。

## 许可

[MIT](LICENSE)
