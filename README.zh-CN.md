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
| 视觉基调 | 数值常态化配色 | 各指标各自按绿/黄/红独立变色,互不影响——和 VS Code 自带的远程连接指示器同一套视觉语言 |
| 交互 | 部分需开侧边栏 | 点击弹出轻量 Webview,不占用常驻空间,关闭不留痕迹 |
| 资源开销 | 部分用 spawn 子进程轮询 | 直读 `/proc`,核心指标零子进程常态开销 |
| 场景感知 | 前后台一致轮询 | 窗口失焦自动降频 |

## 效果预览

```
$(pulse) CPU 23%  MEM 61%                          ← 全部正常
$(pulse) CPU 85%  MEM 40%                          ← 仅 CPU 越过警告阈值,变黄色——内存保持默认色
$(warning) CPU 28%  MEM 97%  DISK 88%  GPU 12%  $(arrow-down) 240.0 KB/s $(arrow-up)  30.0 KB/s ← 仅内存进入严重阈值,变红色——图标跟随已展示指标里最严重的那个
$(debug-pause)                                      ← remotePulse.enabled 关闭后的暂停态,点击恢复
```

CPU、内存、磁盘(最满的挂载点)、GPU(仅第一张卡)、网络最多可以是五个独立着色的状态栏项——通过 `remotePulse.statusBarMetrics` 选择要展示哪些(默认只有 CPU/内存)。网络用 `$(arrow-down)`/`$(arrow-up)` 图标把下载和上传分开展示,而不是合成一个数字——合并了就看不出到底是哪个方向在跑流量;两个速率各自定宽对齐,免得每次刷新数值变短就整体抖动。共用的告警图标反映已勾选指标里最严重的等级——网络只负责展示不参与告警配色,因为吞吐量没有天然的 0-100% 上限——配色用的是 VS Code 官方的 `statusBarItem.warning*`/`error*` 主题 token,所以不管状态栏实际背景是什么颜色(比如被 Remote-SSH 整条改色)都能保持清晰可辨。

鼠标悬停任意指标项,tooltip 里有它最近 2 分钟的迷你趋势图(sparkline)和所属主机;告警图标的 tooltip 则说明点击它会进入指标勾选。

点击 CPU/内存/磁盘/GPU/网络任意一项——或运行「Remote Pulse: 显示趋势图」命令——弹出 30 分钟趋势的折线图,以及磁盘/网络/GPU/Docker 详情(Webview,关闭即销毁,不常驻内存)。点击图例可以临时隐藏某条线,坐标轴量程保持不变,不会因为少了一条线就把剩下的线拉得变了形。告警图标本身则是直接跳转到 `statusBarMetrics` 的多选配置——VS Code 的设置界面对数组配置只能渲染成列表编辑器,不是真正的勾选框,所以这个命令(以及面板齿轮图标里能找到的 `trendPanelSections`/`trendChartMetrics` 对应命令)才是真正"一次性勾选所有想要的项"的入口。

三个配置项覆盖的指标有重叠但故意各自独立:`statusBarMetrics`(`cpu`/`memory`/`disk`/`gpu`/`network`)决定状态栏摘要,`trendPanelSections`(`network`/`gpu`/`docker`)决定面板正文里出现哪些详情区块/行(GPU 卡片、Docker 表格、"System"里的网络那一行;System 和 Storage 始终展示),`trendChartMetrics`(`cpu`/`memory`/`gpu`/`network`)单独决定 30 分钟折线图里画哪几条线——所以你可以让 GPU 详情卡片留在面板里,但不让 GPU 线挤进图表,或者反过来。

## 功能

- **CPU**:总体使用率、核心数(`/proc/stat` 增量算法,非 loadavg)
- **内存**:使用率、已用/总量(`MemAvailable` 而非 `MemFree`,更贴近真实可用内存)
- **磁盘**:各挂载点使用率(自动过滤虚拟文件系统;total/used 字节数完全相同的挂载点——同一块盘被 bind mount 到了不止一个路径,比如 WSL2 里 `/mnt/wslg/distro` 和 `/` 其实是同一块盘——会被合并,只保留路径更浅的那个;默认展示合并去重后的全部真实挂载点、按使用率从高到低排,或手动指定挂载点只看这几个)。作为状态栏项时显示的是最满的那个挂载点,因为真正会先撑爆的就是它
- **网络**:下载/上传速率,任何地方都是分开展示两个数(状态栏图标、图表线条、箭头),从不合并成一个数——合并了就看不出哪个方向在跑流量;回环与虚拟接口(`lo`、`docker0`、`veth*`、`br-*`、`virbr*`、`tap*`、`dummy*`)会被排除,容器之间的通信根本不出本机网卡,算进"网速"会把对外吞吐虚高一大截。可选画进过去 30 分钟图表(下载/上传各一条线,共用同一段独立右侧坐标轴,按窗口内两条线里较大的峰值一起归一化,因为网络速率不像 CPU/内存那样天然有 0-100% 的上限),通过 `trendChartMetrics` 单独控制,默认关闭,且和网络速率是否以文字行展示是两码事
- **GPU**:每张卡的显存占用、利用率、温度(需要 `nvidia-smi`;探测不到时面板会说明原因而不是整块消失,并按节流持续重试,所以 WSL 上扩展启动之后才附加的 GPU 也能显示出来)
- **Docker**:运行中容器数与各容器 CPU/内存占用。socket 依次从 `DOCKER_HOST`(仅 `unix://` 形式,与 docker CLI 一致)、`/var/run/docker.sock`、`$XDG_RUNTIME_DIR` 下的 rootless docker / podman 用户级 socket 里解析——只写死系统级 socket 会把 rootless 用户整体排除在外。"找不到 socket"和"没有权限"在面板里是两句不同的提示
- **阈值告警**:CPU、内存、磁盘、GPU 各自越过警告/严重阈值时独立变为黄色/红色,可选弹出系统通知。通知仅在"跨越"到严重态时弹一次(避免刷屏),并带两个按钮:跳转到趋势图、10 分钟内不再提示
- **历史趋势**:最近 30 分钟的 Webview 折线图,横轴带真实时间刻度,图例可点击隐藏单条线,容器内存同时给出已用量和占比
- **可诊断性**:「Remote Pulse: 查看日志」打开一个输出通道,记录采集失败、可用性探测结果和暂停/恢复事件(同一类错误只记一次,不会每次轮询都刷);「Remote Pulse: 导出历史快照」把内存里的历史加上生效配置写成系统临时目录下的 JSON 文件——提 issue 时附上它
- **自适应轮询**:窗口失焦后自动降频,减少对远程机器的干扰
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
| `remotePulse.enabled` | `true` | 总开关。关闭后停止轮询、隐藏所有状态栏指标项,图标变为暂停态,点击即恢复 |
| `remotePulse.refreshInterval` | `2000` | 前台高频指标(CPU/内存)刷新间隔(ms) |
| `remotePulse.backgroundInterval` | `15000` | 窗口失焦后的降频间隔(ms) |
| `remotePulse.heavyMetricInterval` | `10000` | GPU/Docker 等低频指标独立轮询间隔(ms) |
| `remotePulse.warningThreshold` | `80` | 告警阈值(%) |
| `remotePulse.criticalThreshold` | `95` | 严重阈值(%) |
| `remotePulse.statusBarMetrics` | `["cpu", "memory"]` | 状态栏要展示哪些指标——`cpu`、`memory`、`disk`(最满的挂载点)、`gpu`(仅第一张卡)、`network`(下载/上传用箭头图标分开展示);未选中的指标仍然能在趋势面板里看到。运行「Remote Pulse: 配置状态栏指标」获得真正的多选勾选框 |
| `remotePulse.trendPanelSections` | `["gpu", "docker"]` | 趋势面板正文要展示哪些可选区块/行(GPU 卡片、Docker 表格、"System"里的网络那一行);System 和 Storage 始终展示。和 `trendChartMetrics` 相互独立,不影响图表。运行「Remote Pulse: 配置趋势面板板块」获得真正的多选勾选框 |
| `remotePulse.trendChartMetrics` | `["cpu", "memory"]` | 30 分钟折线图里要画哪几条线——`cpu`、`memory`、`gpu`(仅第一张卡)、`network`(下载/上传各一条线,共用独立右侧坐标轴)。和 `trendPanelSections`、`statusBarMetrics` 相互独立。运行「Remote Pulse: 配置趋势图指标」获得真正的多选勾选框 |
| `remotePulse.enableNotifications` | `false` | CPU/内存/磁盘越过严重阈值时是否弹出系统通知。通知带「查看趋势图」和「10 分钟内不再提示」两个按钮 |
| `remotePulse.diskMountPoints` | `[]` | 指定要监控的挂载点,留空则展示全部真实挂载点(按使用率从高到低排) |

## 命令

- `Remote Pulse: 显示趋势图`(`remotePulse.showTrend`,也绑定在 CPU/内存/磁盘/GPU/网络状态栏项的点击上)
- `Remote Pulse: 立即刷新`(`remotePulse.refresh`)
- `Remote Pulse: 配置状态栏指标`(`remotePulse.configureStatusBarMetrics`,也绑定在告警图标的点击上)
- `Remote Pulse: 配置趋势面板板块`(`remotePulse.configureTrendPanelSections`)
- `Remote Pulse: 配置趋势图指标`(`remotePulse.configureTrendChartMetrics`)
- `Remote Pulse: 暂停 / 恢复监控`(`remotePulse.toggleEnabled`,也绑定在暂停态图标的点击上;恢复时会清空历史,趋势图不会横跨暂停那一段)
- `Remote Pulse: 查看日志`(`remotePulse.showLog`)
- `Remote Pulse: 导出历史快照`(`remotePulse.exportSnapshot`)

## 边界情况

- **非 Linux 远程主机**:CPU/内存自动回退到 Node.js `os` 模块(精度略低),网络模块因无跨平台等价物而直接隐藏
- **首次连接**:状态栏先显示 `$(sync~spin)` 加载态
- **采集失败**(权限/网络抖动):显示 `$(circle-slash)`,失败原因写在该图标的 tooltip 和输出日志里,不弹烦人的错误通知
- **GPU/Docker 不可用**:面板会说明是哪一种情况(未安装、无权限、还没采到第一个点),而不是整块凭空消失。可用性是按节流周期探测的,不是启动时一次性定终身,所以晚起来的 daemon/驱动仍会被识别到

## 开发

```bash
npm install
npm run lint      # eslint(flat config,src/ 开类型感知规则)
npm run build     # tsc 编译到 out/
npm test          # 编译并运行 test/ 下的单元测试(node:test)
npm run test:integration  # 在真实 VS Code 扩展宿主里跑 test/integration/(@vscode/test-cli)
npm run package   # vsce package 生成 .vsix
```

在 VSCode 中打开本项目,按 `F5` 启动 Extension Development Host 即可实时调试(本地 macOS/Windows 环境下 CPU/内存会走 `os` 模块兜底路径,便于在没有远程 Linux 主机时也能验证核心交互)。

## 贡献

CI/发布流水线(GitHub Actions workflow、如何拿到某个 PR 的测试版本)以及实现自动发布所需的一次性仓库 Secrets 配置,见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

## 许可

[MIT](LICENSE)
