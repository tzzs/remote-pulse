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
| 常驻信息量 | CPU\|MEM\|DISK 全部平铺 | 默认只有 1 个 icon + 1 个核心数字,其余进趋势面板 |
| 视觉基调 | 数值常态化配色 | CPU 和内存各自按绿/黄/红独立变色,互不影响——和 VS Code 自带的远程连接指示器同一套视觉语言 |
| 交互 | 部分需开侧边栏 | 点击弹出轻量 Webview,不占用常驻空间,关闭不留痕迹 |
| 资源开销 | 部分用 spawn 子进程轮询 | 直读 `/proc`,核心指标零子进程常态开销 |
| 场景感知 | 前后台一致轮询 | 窗口失焦自动降频 |

## 效果预览

```
$(pulse) CPU 23%  MEM 61%                          ← 全部正常
$(pulse) CPU 85%  MEM 40%                          ← 仅 CPU 越过警告阈值,变黄色——内存保持默认色
$(warning) CPU 28%  MEM 97%  GPU 12%  NET 340 KB/s ← 仅内存进入严重阈值,变红色——图标跟随已展示指标里最严重的那个
```

CPU、内存、GPU(仅第一张卡)、网络(上下行合计速率)最多可以是四个独立着色的状态栏项——通过 `remotePulse.statusBarMetrics` 选择要展示哪些(默认只有 CPU/内存)。共用的告警图标反映已勾选指标里最严重的等级——网络只负责展示不参与告警配色,因为吞吐量没有天然的 0-100% 上限——配色用的是 VS Code 官方的 `statusBarItem.warning*`/`error*` 主题 token,所以不管状态栏实际背景是什么颜色(比如被 Remote-SSH 整条改色)都能保持清晰可辨。

点击 CPU/内存/GPU/网络任意一项——或运行「Remote Pulse: Show Trend Chart」命令——弹出 30 分钟趋势的折线图,以及磁盘/网络/GPU/Docker 详情(Webview,关闭即销毁,不常驻内存)。告警图标本身则是直接跳转到 `statusBarMetrics` 的多选配置——VS Code 的设置界面对数组配置只能渲染成列表编辑器,不是真正的勾选框,所以这个命令(以及面板齿轮图标里能找到的 `trendPanelSections`/`trendChartMetrics` 对应命令)才是真正"一次性勾选所有想要的项"的入口。

三个配置项共用同一套候选指标(`cpu`/`memory`/`gpu`/`network`,面板那个额外还有 `docker`),但故意各自独立:`statusBarMetrics` 决定状态栏摘要,`trendPanelSections` 决定面板正文里出现哪些详情区块/行(GPU 卡片、Docker 表格、"System"里的网络那一行),`trendChartMetrics` 单独决定 30 分钟折线图里画哪几条线——所以你可以让 GPU 详情卡片留在面板里,但不让 GPU 线挤进图表,或者反过来。

## 功能

- **CPU**:总体使用率、核心数(`/proc/stat` 增量算法,非 loadavg)
- **内存**:使用率、已用/总量(`MemAvailable` 而非 `MemFree`,更贴近真实可用内存)
- **磁盘**:各挂载点使用率(自动过滤虚拟文件系统,默认展示使用率 Top 3,或手动指定挂载点)
- **网络**:上行/下行速率;可选画进过去 30 分钟图表的独立右侧坐标轴上(按窗口内自身峰值归一化,因为网络速率不像 CPU/内存那样天然有 0-100% 的上限),通过 `trendChartMetrics` 单独控制,默认关闭,且和网络速率是否以文字行展示是两码事
- **GPU**:显存占用、利用率、温度(需要 `nvidia-smi`,不存在则模块整体不激活)
- **Docker**:运行中容器数与各容器 CPU/内存占用(需要可访问 `/var/run/docker.sock`,无权限则静默降级)
- **阈值告警**:CPU 和内存各自越过警告/严重阈值时独立变为黄色/红色,可选弹出系统通知(仅在"跨越"到严重态时通知一次,避免刷屏)
- **历史趋势**:最近 30 分钟的 Webview 折线图
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
| `remotePulse.statusBarMetrics` | `["cpu", "memory"]` | 状态栏要展示哪些指标——`cpu`、`memory`、`gpu`(仅第一张卡)、`network`(合计速率);未选中的指标仍然能在趋势面板里看到。运行「Remote Pulse: 配置状态栏指标」获得真正的多选勾选框 |
| `remotePulse.trendPanelSections` | `["gpu", "docker"]` | 趋势面板正文要展示哪些可选区块/行(GPU 卡片、Docker 表格、"System"里的网络那一行);System 和 Storage 始终展示。和 `trendChartMetrics` 相互独立,不影响图表。运行「Remote Pulse: 配置趋势面板板块」获得真正的多选勾选框 |
| `remotePulse.trendChartMetrics` | `["cpu", "memory"]` | 30 分钟折线图里要画哪几条线——`cpu`、`memory`、`gpu`(仅第一张卡)、`network`(独立右侧坐标轴)。和 `trendPanelSections`、`statusBarMetrics` 相互独立。运行「Remote Pulse: 配置趋势图指标」获得真正的多选勾选框 |
| `remotePulse.enableNotifications` | `false` | 越过严重阈值时是否弹出系统通知 |
| `remotePulse.diskMountPoints` | `[]` | 指定要监控的挂载点,留空则自动选 Top 3 |

## 命令

- `Remote Pulse: 显示趋势图`(`remotePulse.showTrend`,也绑定在 CPU/内存/GPU/网络状态栏项的点击上)
- `Remote Pulse: 立即刷新`(`remotePulse.refresh`)
- `Remote Pulse: 配置状态栏指标`(`remotePulse.configureStatusBarMetrics`,也绑定在告警图标的点击上)
- `Remote Pulse: 配置趋势面板板块`(`remotePulse.configureTrendPanelSections`)
- `Remote Pulse: 配置趋势图指标`(`remotePulse.configureTrendChartMetrics`)

## 边界情况

- **非 Linux 远程主机**:CPU/内存自动回退到 Node.js `os` 模块(精度略低),网络模块因无跨平台等价物而直接隐藏
- **首次连接**:状态栏先显示 `$(sync~spin)` 加载态
- **采集失败**(权限/网络抖动):显示 `$(circle-slash)`,不弹烦人的错误通知
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
