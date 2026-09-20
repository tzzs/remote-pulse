import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { PulseStatusBar, StatusBarContext } from '../../src/statusBar';
import { Snapshot } from '../../src/types';
import { RemotePulseConfig } from '../../src/config';

function baseConfig(overrides: Partial<RemotePulseConfig> = {}): RemotePulseConfig {
  return {
    enabled: true,
    refreshInterval: 2000,
    backgroundInterval: 15000,
    heavyMetricInterval: 10000,
    warningThreshold: 80,
    criticalThreshold: 95,
    statusBarMetrics: ['cpu', 'memory'],
    trendPanelSections: ['gpu', 'docker'],
    trendChartMetrics: ['cpu', 'memory'],
    enableNotifications: false,
    diskMountPoints: [],
    ...overrides,
  };
}

function testContext(overrides: Partial<StatusBarContext> = {}): StatusBarContext {
  return {
    hostLabel: 'testhost',
    history: () => [],
    ...overrides,
  };
}

function snapshotWith(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    timestamp: Date.now(),
    cpu: { percent: 10, cores: 4 },
    memory: { total: 100, used: 10, available: 90, percent: 10 },
    ...overrides,
  };
}

// 颜色现在走 VS Code 官方的 statusBarItem.warning*/error* 主题 token 而不是写死的十六进制值,
// 所以断言的是 ThemeColor 的 id,不再依赖测试宿主具体跑的是哪套主题。
const WARNING_FG = 'statusBarItem.warningForeground';
const WARNING_BG = 'statusBarItem.warningBackground';
const ERROR_FG = 'statusBarItem.errorForeground';
const ERROR_BG = 'statusBarItem.errorBackground';

function themeColorId(color: string | vscode.ThemeColor | undefined): string | undefined {
  return color instanceof vscode.ThemeColor ? color.id : undefined;
}

suite('PulseStatusBar (integration)', () => {
  let bar: PulseStatusBar;

  teardown(() => {
    bar?.dispose();
  });

  test('all six items sit on the left with descending priority, next to the Remote-SSH indicator', () => {
    bar = new PulseStatusBar(testContext());
    const { icon, cpu, mem, disk, gpu, network } = bar.debugState;
    assert.equal(icon.alignment, vscode.StatusBarAlignment.Left);
    assert.equal(cpu.alignment, vscode.StatusBarAlignment.Left);
    assert.equal(mem.alignment, vscode.StatusBarAlignment.Left);
    assert.equal(disk.alignment, vscode.StatusBarAlignment.Left);
    assert.equal(gpu.alignment, vscode.StatusBarAlignment.Left);
    assert.equal(network.alignment, vscode.StatusBarAlignment.Left);
    assert.equal(icon.priority, 1000);
    assert.equal(cpu.priority, 999);
    assert.equal(mem.priority, 998);
    assert.equal(disk.priority, 997);
    assert.equal(gpu.priority, 996);
    assert.equal(network.priority, 995);
  });

  test('starts in a loading state before the first update, with CPU/memory items hidden', () => {
    bar = new PulseStatusBar(testContext());
    assert.equal(bar.debugState.icon.text, '$(sync~spin)');
    assert.equal(bar.debugState.cpu.visible, false);
    assert.equal(bar.debugState.mem.visible, false);
  });

  test('falls back to loading when both metrics are missing', () => {
    bar = new PulseStatusBar(testContext());
    bar.update({ timestamp: Date.now() }, baseConfig(), 'ok');
    assert.equal(bar.debugState.icon.text, '$(sync~spin)');
    assert.equal(bar.debugState.cpu.visible, false);
    assert.equal(bar.debugState.mem.visible, false);
  });

  test('shows CPU and memory as independent items once data is available', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(snapshotWith({ cpu: { percent: 12, cores: 8 }, memory: { total: 100, used: 34, available: 66, percent: 34 } }), baseConfig(), 'ok');
    assert.equal(bar.debugState.icon.text, '$(pulse)');
    assert.equal(bar.debugState.cpu.text, 'CPU 12%');
    assert.equal(bar.debugState.mem.text, 'MEM 34%');
    assert.equal(bar.debugState.cpu.visible, true);
    assert.equal(bar.debugState.mem.visible, true);
  });

  test('normal level leaves color/backgroundColor unset, inheriting the theme default status bar foreground', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(snapshotWith(), baseConfig(), 'ok');
    assert.equal(bar.debugState.icon.color, undefined);
    assert.equal(bar.debugState.cpu.color, undefined);
    assert.equal(bar.debugState.mem.color, undefined);
    assert.equal(bar.debugState.icon.backgroundColor, undefined);
    assert.equal(bar.debugState.cpu.backgroundColor, undefined);
    assert.equal(bar.debugState.mem.backgroundColor, undefined);
  });

  test('CPU crossing warning colors only the CPU item and the icon with the warning theme token, memory stays unset', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(snapshotWith({ cpu: { percent: 85, cores: 4 } }), baseConfig(), 'ok');
    assert.equal(themeColorId(bar.debugState.cpu.color), WARNING_FG);
    assert.equal(themeColorId(bar.debugState.cpu.backgroundColor), WARNING_BG);
    assert.equal(bar.debugState.mem.color, undefined);
    assert.equal(themeColorId(bar.debugState.icon.color), WARNING_FG);
    assert.equal(themeColorId(bar.debugState.icon.backgroundColor), WARNING_BG);
  });

  test('memory going critical alone colors only memory and the icon with the error theme token, CPU stays unset, and the icon glyph swaps to the warning triangle', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(snapshotWith({ memory: { total: 100, used: 99, available: 1, percent: 99 } }), baseConfig(), 'ok');
    assert.equal(themeColorId(bar.debugState.mem.color), ERROR_FG);
    assert.equal(themeColorId(bar.debugState.mem.backgroundColor), ERROR_BG);
    assert.equal(bar.debugState.cpu.color, undefined);
    assert.equal(themeColorId(bar.debugState.icon.color), ERROR_FG);
    assert.equal(themeColorId(bar.debugState.icon.backgroundColor), ERROR_BG);
    assert.equal(bar.debugState.icon.text, '$(warning)');
  });

  test('CPU critical and memory warning at once keep their own theme tokens, icon follows the worse of the two', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(snapshotWith({ cpu: { percent: 96, cores: 4 }, memory: { total: 100, used: 82, available: 18, percent: 82 } }), baseConfig(), 'ok');
    assert.equal(themeColorId(bar.debugState.cpu.color), ERROR_FG);
    assert.equal(themeColorId(bar.debugState.mem.color), WARNING_FG);
    assert.equal(themeColorId(bar.debugState.icon.color), ERROR_FG);
  });

  test('the alert icon and every metric item carry a tooltip (trend sparkline / click hint)', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(snapshotWith(), baseConfig(), 'ok');
    assert.notEqual(bar.debugState.icon.tooltip, undefined);
    for (const item of [bar.debugState.cpu, bar.debugState.mem]) {
      const tooltip = item.tooltip as vscode.MarkdownString;
      assert.ok(tooltip instanceof vscode.MarkdownString);
      // 文案随显示语言变化,只断言非空;结构(代码块围栏)在下面单独测。
      assert.ok(tooltip.value.length > 0);
    }
  });

  test('CPU tooltip embeds a sparkline code block once history points exist', () => {
    bar = new PulseStatusBar(testContext({ history: () => [10, 40, 70, 25] }));
    bar.update(snapshotWith(), baseConfig(), 'ok');
    const tooltip = bar.debugState.cpu.tooltip as vscode.MarkdownString;
    assert.match(tooltip.value, /`[▁▂▃▄▅▆▇█]+`/);
  });

  test('showError sets an error icon and hides CPU/memory', () => {
    bar = new PulseStatusBar(testContext());
    bar.showError('permission denied');
    assert.equal(bar.debugState.icon.text, '$(circle-slash)');
    assert.equal(bar.debugState.cpu.visible, false);
    assert.equal(bar.debugState.mem.visible, false);
  });

  test('statusBarMetrics can hide memory, leaving only CPU visible and the icon following CPU alone', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(
      snapshotWith({ memory: { total: 100, used: 99, available: 1, percent: 99 } }),
      baseConfig({ statusBarMetrics: ['cpu'] }),
      'ok',
    );
    assert.equal(bar.debugState.cpu.visible, true);
    assert.equal(bar.debugState.mem.visible, false);
    // 内存被隐藏,即使它已经严重超标,图标也只看 CPU(正常态),不该被隐藏的指标带偏。
    assert.equal(bar.debugState.icon.color, undefined);
  });

  test('statusBarMetrics can hide CPU, leaving only memory visible', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(snapshotWith(), baseConfig({ statusBarMetrics: ['memory'] }), 'ok');
    assert.equal(bar.debugState.cpu.visible, false);
    assert.equal(bar.debugState.mem.visible, true);
  });

  // CPU/内存/GPU/网络四个数字项点了都进趋势面板,这是命令面板之外看磁盘/Docker等其余指标的唯一入口。
  // 告警图标改点"配置状态栏指标"多选框——四个数字项已经能进面板了,图标不用再重复这条绑定。
  test('clicking a metric item opens the trend panel; clicking the alert icon opens the status bar metrics picker', () => {
    bar = new PulseStatusBar(testContext());
    assert.equal(bar.debugState.icon.command, 'remotePulse.configureStatusBarMetrics');
    assert.equal(bar.debugState.cpu.command, 'remotePulse.showTrend');
    assert.equal(bar.debugState.mem.command, 'remotePulse.showTrend');
    assert.equal(bar.debugState.gpu.command, 'remotePulse.showTrend');
    assert.equal(bar.debugState.network.command, 'remotePulse.showTrend');
  });

  test('GPU item is hidden even when configured if no GPU data was collected (no nvidia-smi)', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(snapshotWith(), baseConfig({ statusBarMetrics: ['cpu', 'memory', 'gpu'] }), 'ok');
    assert.equal(bar.debugState.gpu.visible, false);
  });

  test('GPU item shows the primary GPU utilization and joins the overall alert level', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(
      snapshotWith({
        gpus: [
          { index: 0, utilizationPercent: 97, memoryUsedMb: 1000, memoryTotalMb: 8000, temperatureC: 60 },
          { index: 1, utilizationPercent: 5, memoryUsedMb: 100, memoryTotalMb: 8000, temperatureC: 40 },
        ],
      }),
      baseConfig({ statusBarMetrics: ['cpu', 'memory', 'gpu'] }),
      'ok',
    );
    assert.equal(bar.debugState.gpu.visible, true);
    assert.equal(bar.debugState.gpu.text, 'GPU 97%');
    assert.equal(themeColorId(bar.debugState.gpu.color), ERROR_FG);
    assert.equal(themeColorId(bar.debugState.icon.color), ERROR_FG);
  });

  test('Network item is hidden until config enables it and a rate sample has been collected', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(snapshotWith({ network: { rxRate: 1024, txRate: 512 } }), baseConfig(), 'ok');
    assert.equal(bar.debugState.network.visible, false);

    bar.update(snapshotWith(), baseConfig({ statusBarMetrics: ['cpu', 'memory', 'network'] }), 'ok');
    assert.equal(bar.debugState.network.visible, false);
  });

  test('Network item shows download and upload separately with arrow icons, and never takes an alert color', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(
      snapshotWith({ network: { rxRate: 900_000, txRate: 12_000 } }),
      baseConfig({ statusBarMetrics: ['cpu', 'memory', 'network'] }),
      'ok',
    );
    assert.equal(bar.debugState.network.visible, true);
    // 分开标 arrow-down/arrow-up,而不是把上下行加在一起,不然分不清到底是在上传还是下载。
    // 数字定宽右对齐(5 字符),900 KB/s 和 11 KB/s 前后刷新宽度一致,不抖动。
    assert.equal(bar.debugState.network.text, '$(arrow-down) 878.9 KB/s $(arrow-up)  11.7 KB/s');
    assert.equal(bar.debugState.network.color, undefined);
    assert.equal(bar.debugState.network.backgroundColor, undefined);
    // 网络没有告警语义,不该把图标带成红色——即使数值很大。
    assert.equal(themeColorId(bar.debugState.icon.color), undefined);
  });

  test('disk item shows the fullest mount point and joins the overall alert level', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(
      snapshotWith({
        disks: [
          { mountPoint: '/', total: 100, used: 20, percent: 20 },
          { mountPoint: '/data', total: 100, used: 97, percent: 97 },
        ],
      }),
      baseConfig({ statusBarMetrics: ['cpu', 'memory', 'disk'] }),
      'ok',
    );
    assert.equal(bar.debugState.disk.visible, true);
    assert.equal(bar.debugState.disk.text, 'DISK 97%');
    assert.equal(themeColorId(bar.debugState.disk.color), ERROR_FG);
    assert.equal(themeColorId(bar.debugState.icon.color), ERROR_FG);
  });

  test('disk item stays hidden when no disk data exists, even if configured', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(snapshotWith({ disks: [] }), baseConfig({ statusBarMetrics: ['cpu', 'memory', 'disk'] }), 'ok');
    assert.equal(bar.debugState.disk.visible, false);
    assert.equal(bar.debugState.icon.color, undefined);
  });

  test('showPaused swaps the icon to the resume command and hides every metric item', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(snapshotWith(), baseConfig(), 'ok');
    bar.showPaused();
    assert.equal(bar.debugState.icon.text, '$(debug-pause)');
    assert.equal(bar.debugState.icon.command, 'remotePulse.toggleEnabled');
    assert.equal(bar.debugState.cpu.visible, false);
    assert.equal(bar.debugState.mem.visible, false);
  });

  // CPU 是增量计算,头几轮必然没有值;此前只认 CPU,"CPU 拿不到但内存正常"会让状态栏永久转圈。
  test('renders memory alone while CPU has no sample yet, instead of staying stuck on loading', () => {
    bar = new PulseStatusBar(testContext());
    bar.update(
      snapshotWith({ cpu: undefined, memory: { total: 100, used: 55, available: 45, percent: 55 } }),
      baseConfig(),
      'ok',
    );
    assert.equal(bar.debugState.cpu.visible, false);
    assert.equal(bar.debugState.mem.visible, true);
    assert.equal(bar.debugState.mem.text, 'MEM 55%');
  });
});
