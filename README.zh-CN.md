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
$(warning) CPU 28%  MEM 97%  GPU 12%  $(arrow-down) 240 KB/s $(arrow-up) 30 KB/s ← 仅内存进入严重阈值,变红色——图标跟随已展示指标里最严重的那个
```

CPU、内存、GPU(仅第一张卡)、网络最多可以是四个独立着色的状态栏项——通过 `remotePulse.statusBarMetrics` 选择要展示哪些(默认只有 CPU/内存)。网络用 `$(arrow-down)`/`$(arrow-up)` 图标把下载和上传分开展示,而不是合成一个数字——合并了就看不出到底是哪个方向在跑流量。共用的告警图标反映已勾选指标里最严重的等级——网络只负责展示不参与告警配色,因为吞吐量没有天然的 0-100% 上限——配色用的是 VS Code 官方的 `statusBarItem.warning*`/`error*` 主题 token,所以不管状态栏实际背景是什么颜色(比如被 Remote-SSH 整条改色)都能保持清晰可辨。

点击 CPU/内存/GPU/网络任意一项——或运行「Remote Pulse: Show Trend Chart」命令——弹出 30 分钟趋势的折线图,以及磁盘/网络/GPU/Docker 详情(Webview,关闭即销毁,不常驻内存)。告警图标本身则是直接跳转到 `statusBarMetrics` 的多选配置——VS Code 的设置界面对数组配置只能渲染成列表编辑器,不是真正的勾选框,所以这个命令(以及面板齿轮图标里能找到的 `trendPanelSections`/`trendChartMetrics` 对应命令)才是真正"一次性勾选所有想要的项"的入口。

三个配置项共用同一套候选指标(`cpu`/`memory`/`gpu`/`network`,面板那个额外还有 `docker`),但故意各自独立:`statusBarMetrics` 决定状态栏摘要,`trendPanelSections` 决定面板正文里出现哪些详情区块/行(GPU 卡片、Docker 表格、"System"里的网络那一行),`trendChartMetrics` 单独决定 30 分钟折线图里画哪几条线——所以你可以让 GPU 详情卡片留在面板里,但不让 GPU 线挤进图表,或者反过来。

## 功能

- **CPU**:总体使用率、核心数(`/proc/stat` 增量算法,非 loadavg),另附按核数折算的 1/5/15 分钟负载
- **内存**:使用率、已用/总量(`MemAvailable` 而非 `MemFree`,更贴近真实可用内存);主机配置了 swap 时自动显示交换分区用量
- **容器感知**:在 Dev Container / Codespaces 中按 cgroup 配额(v1、v2 均支持)而不是宿主机 `/proc` 的数值统计 CPU 与内存,并标注 `cgroup 限额`,让你知道分母是什么(`remotePulse.cgroupAware`)
- **磁盘**:各挂载点使用率,口径与 `df` 完全一致(root 预留块不计入已用;自动过滤虚拟文件系统;同一块盘的 bind mount 合并为路径更浅的那个;按使用率排序)。可选读写吞吐(`/proc/diskstats`,只统计整块设备,不重复计算分区)
- **网络**:下载/上传速率,任何地方都分开展示两个数。默认排除虚拟网卡(`docker0`、`veth*`、`br-*`、`tun*` 等),它们的流量要么是容器内部的,要么会被重复计算;可用 `remotePulse.networkInterfaces` 指定网卡
- **GPU**:显存占用、利用率、温度(需要 `nvidia-smi`)。多卡主机可选择状态栏和图表跟随 GPU 0 还是最忙的卡(`remotePulse.gpuSelection`)。温度有独立的 °C 阈值
- **进程 Top N**:可选的高 CPU 进程列表,进程 CPU% 与总 CPU 行同一口径
- **Docker**:运行中容器数与各容器 CPU/内存占用,限制并发并设容器上限,容器多的主机不会压垮 daemon
- **悬浮详情**:每个状态栏项都带 tooltip,展示主机、最近 5 分钟的 sparkline 以及全部已采集指标
- **阈值告警**:CPU 和内存各自独立变黄/变红;可选对 CPU/内存/磁盘/GPU 弹出通知(`remotePulse.notificationMetrics`),每次越界只通知一次,并提供"查看趋势图"/"静音 1 小时"
- **历史趋势**:时间窗口可配置的 Webview 折线图(`remotePulse.trendWindowMinutes`);为屏幕阅读器提供区块地标、进度条语义与图表文字描述
- **自适应轮询**:窗口失焦后自动降频;变化慢的指标(磁盘、GPU、Docker、进程)走独立的低频循环
- **可诊断**:采集失败在界面上保持安静,但会记录到 `Remote Pulse` 输出通道(`Remote Pulse: 查看日志`)
- **界面本地化**:命令、设置项、状态栏/Webview 文案跟随 VS Code 显示语言自动切换(默认英文,内置简体中文翻译)

## 安装

可以在 VSCode 扩展面板搜索 **Remote Pulse**,或直接从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=tanzz.remote-pulse) 或 [Open VSX Registry](https://open-vsx.org/extension/tanzz/remote-pulse)(例如给 VSCodium 等基于 Open VSX 的编辑器用)安装。

也可以从 [Releases](../../releases) 下载 `.vsix` 文件,在 VSCode 中执行:

```
Extensions: Install from VSIX...
```

或命令行安装:

```bash
code --install-extension remote-pulse-<version>.vsix
```

安装后通过 Remote-SSH 连接到 Linux 远程主机即可在状态栏看到指标(本插件声明为 `extensionKind: workspace`,会自动运行在远程 extension host 上,无需额外配置)。

## 配置项

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `remotePulse.refreshInterval` | `2000` | 前台高频指标(CPU/内存/网络)刷新间隔,单位 ms |
| `remotePulse.backgroundInterval` | `15000` | 窗口失焦后的降频刷新间隔,单位 ms |
| `remotePulse.heavyMetricInterval` | `10000` | 低频指标(磁盘、GPU、Docker、进程)的轮询间隔,单位 ms |
| `remotePulse.warningThreshold` | `80` | 告警阈值(%)。若比严重阈值还高,两者会自动互换 |
| `remotePulse.criticalThreshold` | `95` | 严重阈值(%) |
| `remotePulse.gpuTempWarningThreshold` | `80` | GPU 温度告警阈值(°C) |
| `remotePulse.gpuTempCriticalThreshold` | `90` | GPU 温度严重阈值(°C) |
| `remotePulse.statusBarMetrics` | `["cpu", "memory"]` | 状态栏展示的指标 —— `cpu`、`memory`、`gpu`、`network`。运行 `Remote Pulse: 配置状态栏指标` 可多选 |
| `remotePulse.statusBarAlignment` | `"left"` | `left`(靠近远程指示器)或 `right` |
| `remotePulse.trendPanelSections` | `["gpu", "docker"]` | 面板可选板块 —— `network`、`diskIo`、`gpu`、`processes`、`docker`。System 与 Storage 始终显示,与图表相互独立 |
| `remotePulse.trendChartMetrics` | `["cpu", "memory"]` | 趋势图中的折线 —— `cpu`、`memory`、`gpu`、`network`(下载/上传画在独立的右侧坐标轴上) |
| `remotePulse.trendWindowMinutes` | `30` | 趋势图覆盖的历史时长(1–240 分钟),内存中的历史容量随它与刷新间隔自动调整 |
| `remotePulse.enableNotifications` | `false` | 越过严重阈值时是否弹出通知 |
| `remotePulse.notificationMetrics` | `["cpu", "memory", "disk"]` | 哪些指标可以触发通知 —— `cpu`、`memory`、`disk`、`gpu` |
| `remotePulse.diskMountPoints` | `[]` | 要监控的挂载点;留空 = 全部真实挂载点,按使用率排序 |
| `remotePulse.networkInterfaces` | `[]` | 要统计的网卡;留空 = 全部物理网卡(排除虚拟网卡) |
| `remotePulse.gpuSelection` | `"primary"` | 多卡主机上状态栏与图表跟随哪张卡 —— `primary` 或 `busiest` |
| `remotePulse.topProcessCount` | `5` | 进程 Top 板块的行数 |
| `remotePulse.dockerMaxContainers` | `20` | 最多为多少个容器拉取明细,其余只计入总数 |
| `remotePulse.cgroupAware` | `true` | 存在 cgroup 配额时按配额统计 CPU/内存 |

## 命令

命令只在远程窗口(插件真正在监控时)出现在命令面板中。

- `Remote Pulse: 显示趋势图`(`remotePulse.showTrend`,点击状态栏的 CPU/内存/GPU/网络项同样触发)
- `Remote Pulse: 立即刷新`(`remotePulse.refresh`)
- `Remote Pulse: 查看日志`(`remotePulse.showLogs`)
- `Remote Pulse: 配置状态栏指标`(`remotePulse.configureStatusBarMetrics`,点击告警图标同样触发)
- `Remote Pulse: 配置趋势面板板块`(`remotePulse.configureTrendPanelSections`)
- `Remote Pulse: 配置趋势图指标`(`remotePulse.configureTrendChartMetrics`)
- `Remote Pulse: 配置通知指标`(`remotePulse.configureNotificationMetrics`)

## 边界情况

- **非 Linux 远程主机**:CPU/内存自动回退到 Node.js `os` 模块(精度略低),网络、磁盘读写、进程模块因无跨平台等价物而直接隐藏
- **首次连接**:状态栏先显示 `$(sync~spin)` 加载态,tooltip 中说明正在采集
- **部分采集失败**:各采集器独立结算——某一路失败时沿用上一次的值若干轮后再清空,不会连带其他指标一起消失
- **全部采集失败**:显示 `$(circle-slash)`,原因写在 tooltip 与输出通道里,不弹烦人的错误通知
- **挂死的网络挂载**:每次 `statfs` 2 秒超时,失联的 NFS/CIFS 不会拖住扩展宿主
- **GPU/Docker 不可用**:每 5 分钟重新探测一次,之后启动 Docker daemon 或装上驱动都能被识别,无需重载窗口

## 开发

```bash
npm install
npm run build     # tsc 编译到 out/
npm test          # 编译并运行 test/ 下的单元测试(node:test)
npm run lint      # 对 src/、test/ 以及 media/ 下的 webview 脚本运行 ESLint
npm run test:integration  # 在真实 VS Code 扩展宿主里跑 test/integration/(@vscode/test-cli)
npm run package   # vsce package 生成 .vsix
```

如果集成测试宿主启动时报 `listen EINVAL … .sock`(在 git worktree 或嵌套很深的目录里很常见——Unix socket 路径上限 103 个字符),把用户数据目录指到短路径即可:

```bash
VSCODE_TEST_USER_DATA_DIR=/tmp/rp-ud npm run test:integration
```

趋势面板的样式和脚本以真实文件形式放在 `media/` 下;`media/chart.js` 承载图表的计算逻辑,由 `test/chart.test.mjs` 直接做单元测试。

在 VSCode 中打开本项目,按 `F5` 启动 Extension Development Host 即可实时调试(本地 macOS/Windows 环境下 CPU/内存会走 `os` 模块兜底路径,便于在没有远程 Linux 主机时也能验证核心交互)。

## 贡献

CI/发布流水线(GitHub Actions workflow、如何拿到某个 PR 的测试版本)以及实现自动发布所需的一次性仓库 Secrets 配置,见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

## 许可

[MIT](LICENSE)
