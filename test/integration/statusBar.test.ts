import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { PulseStatusBar } from '../../src/statusBar';
import { Snapshot } from '../../src/types';
import { RemotePulseConfig } from '../../src/config';

function baseConfig(overrides: Partial<RemotePulseConfig> = {}): RemotePulseConfig {
  return {
    refreshInterval: 2000,
    backgroundInterval: 15000,
    heavyMetricInterval: 10000,
    warningThreshold: 80,
    criticalThreshold: 95,
    template: '$(pulse) CPU ${cpu}%  MEM ${mem}%',
    statusBarMetrics: ['cpu', 'memory'],
    enableGPU: true,
    enableDocker: true,
    enableNetwork: false,
    enableNotifications: false,
    diskMountPoints: [],
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

function colorId(color: string | vscode.ThemeColor | undefined): string | undefined {
  return color instanceof vscode.ThemeColor ? color.id : undefined;
}

suite('PulseStatusBar (integration)', () => {
  let bar: PulseStatusBar;

  teardown(() => {
    bar?.dispose();
  });

  test('all three items sit on the left with descending priority, next to the Remote-SSH indicator', () => {
    bar = new PulseStatusBar();
    const { icon, cpu, mem } = bar.debugState;
    assert.equal(icon.alignment, vscode.StatusBarAlignment.Left);
    assert.equal(cpu.alignment, vscode.StatusBarAlignment.Left);
    assert.equal(mem.alignment, vscode.StatusBarAlignment.Left);
    assert.equal(icon.priority, 1000);
    assert.equal(cpu.priority, 999);
    assert.equal(mem.priority, 998);
  });

  test('starts in a loading state before the first update, with CPU/memory items hidden', () => {
    bar = new PulseStatusBar();
    assert.equal(bar.debugState.icon.text, '$(sync~spin)');
    assert.equal(bar.debugState.cpu.visible, false);
    assert.equal(bar.debugState.mem.visible, false);
  });

  test('falls back to loading when both metrics are missing', () => {
    bar = new PulseStatusBar();
    bar.update({ timestamp: Date.now() }, baseConfig(), 'ok');
    assert.equal(bar.debugState.icon.text, '$(sync~spin)');
    assert.equal(bar.debugState.cpu.visible, false);
    assert.equal(bar.debugState.mem.visible, false);
  });

  test('shows CPU and memory as independent items once data is available', () => {
    bar = new PulseStatusBar();
    bar.update(snapshotWith({ cpu: { percent: 12, cores: 8 }, memory: { total: 100, used: 34, available: 66, percent: 34 } }), baseConfig(), 'ok');
    assert.equal(bar.debugState.icon.text, '$(pulse)');
    assert.equal(bar.debugState.cpu.text, 'CPU 12%');
    assert.equal(bar.debugState.mem.text, 'MEM 34%');
    assert.equal(bar.debugState.cpu.visible, true);
    assert.equal(bar.debugState.mem.visible, true);
  });

  test('normal level colors the icon, CPU and memory green independently', () => {
    bar = new PulseStatusBar();
    bar.update(snapshotWith(), baseConfig(), 'ok');
    assert.equal(colorId(bar.debugState.icon.color), 'terminal.ansiBrightGreen');
    assert.equal(colorId(bar.debugState.cpu.color), 'terminal.ansiBrightGreen');
    assert.equal(colorId(bar.debugState.mem.color), 'terminal.ansiBrightGreen');
  });

  test('CPU crossing warning colors only the CPU item and the icon yellow, memory stays green', () => {
    bar = new PulseStatusBar();
    bar.update(snapshotWith({ cpu: { percent: 85, cores: 4 } }), baseConfig(), 'ok');
    assert.equal(colorId(bar.debugState.cpu.color), 'terminal.ansiBrightYellow');
    assert.equal(colorId(bar.debugState.mem.color), 'terminal.ansiBrightGreen');
    assert.equal(colorId(bar.debugState.icon.color), 'terminal.ansiBrightYellow');
  });

  test('memory going critical alone colors only memory and the icon red, CPU stays green, and the icon glyph swaps to the warning triangle', () => {
    bar = new PulseStatusBar();
    bar.update(snapshotWith({ memory: { total: 100, used: 99, available: 1, percent: 99 } }), baseConfig(), 'ok');
    assert.equal(colorId(bar.debugState.mem.color), 'terminal.ansiBrightRed');
    assert.equal(colorId(bar.debugState.cpu.color), 'terminal.ansiBrightGreen');
    assert.equal(colorId(bar.debugState.icon.color), 'terminal.ansiBrightRed');
    assert.equal(bar.debugState.icon.text, '$(warning)');
  });

  test('CPU critical and memory warning at once keep their own colors, icon follows the worse of the two', () => {
    bar = new PulseStatusBar();
    bar.update(snapshotWith({ cpu: { percent: 96, cores: 4 }, memory: { total: 100, used: 82, available: 18, percent: 82 } }), baseConfig(), 'ok');
    assert.equal(colorId(bar.debugState.cpu.color), 'terminal.ansiBrightRed');
    assert.equal(colorId(bar.debugState.mem.color), 'terminal.ansiBrightYellow');
    assert.equal(colorId(bar.debugState.icon.color), 'terminal.ansiBrightRed');
  });

  test('has no tooltip, so hovering over the status bar items shows nothing', () => {
    bar = new PulseStatusBar();
    bar.update(snapshotWith(), baseConfig(), 'ok');
    assert.equal(bar.debugState.icon.tooltip, undefined);
    assert.equal(bar.debugState.cpu.tooltip, undefined);
    assert.equal(bar.debugState.mem.tooltip, undefined);
  });

  test('showError sets an error icon and hides CPU/memory', () => {
    bar = new PulseStatusBar();
    bar.showError('permission denied');
    assert.equal(bar.debugState.icon.text, '$(circle-slash)');
    assert.equal(bar.debugState.cpu.visible, false);
    assert.equal(bar.debugState.mem.visible, false);
  });

  test('statusBarMetrics can hide memory, leaving only CPU visible and the icon following CPU alone', () => {
    bar = new PulseStatusBar();
    bar.update(
      snapshotWith({ memory: { total: 100, used: 99, available: 1, percent: 99 } }),
      baseConfig({ statusBarMetrics: ['cpu'] }),
      'ok',
    );
    assert.equal(bar.debugState.cpu.visible, true);
    assert.equal(bar.debugState.mem.visible, false);
    // 内存被隐藏,即使它已经严重超标,图标也只看 CPU(正常态),不该被隐藏的指标带偏。
    assert.equal(colorId(bar.debugState.icon.color), 'terminal.ansiBrightGreen');
  });

  test('statusBarMetrics can hide CPU, leaving only memory visible', () => {
    bar = new PulseStatusBar();
    bar.update(snapshotWith(), baseConfig({ statusBarMetrics: ['memory'] }), 'ok');
    assert.equal(bar.debugState.cpu.visible, false);
    assert.equal(bar.debugState.mem.visible, true);
  });

  // 悬浮 tooltip 已移除,磁盘/网络/GPU/Docker 只在趋势面板里能看到,
  // 点击就是这个面板在命令面板之外的唯一入口——所以这条绑定不能再被摘掉,三个项都要能点开。
  test('clicking any of the three items opens the trend panel', () => {
    bar = new PulseStatusBar();
    assert.equal(bar.debugState.icon.command, 'remotePulse.showTrend');
    assert.equal(bar.debugState.cpu.command, 'remotePulse.showTrend');
    assert.equal(bar.debugState.mem.command, 'remotePulse.showTrend');
  });
});
