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
    enableGpu: true,
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

suite('PulseStatusBar (integration)', () => {
  let bar: PulseStatusBar;

  teardown(() => {
    bar?.dispose();
  });

  test('sits on the left with a high priority, next to the Remote-SSH indicator', () => {
    bar = new PulseStatusBar();
    assert.equal(bar.debugState.alignment, vscode.StatusBarAlignment.Left);
    assert.equal(bar.debugState.priority, 1000);
  });

  test('starts in a loading state before the first update', () => {
    bar = new PulseStatusBar();
    assert.equal(bar.debugState.text, '$(sync~spin)');
  });

  test('falls back to loading when both metrics are missing', () => {
    bar = new PulseStatusBar();
    bar.update({ timestamp: Date.now() }, baseConfig(), 'ok');
    assert.equal(bar.debugState.text, '$(sync~spin)');
  });

  test('shows both CPU and memory using the configured template', () => {
    bar = new PulseStatusBar();
    bar.update(snapshotWith({ cpu: { percent: 12, cores: 8 }, memory: { total: 100, used: 34, available: 66, percent: 34 } }), baseConfig(), 'ok');
    assert.equal(bar.debugState.text, '$(pulse) CPU 12%  MEM 34%');
  });

  test('normal level leaves color/background untouched, inheriting the theme default', () => {
    // 状态栏背景会被 Vim 模式插件、Remote 连接等场景动态改写,而 vscode API 没有办法读取
    // "当前实际背景色",所以正常态特意不设自定义前景色——不设置才能始终跟随主题的
    // statusBar.foreground,不会在某些背景下变得不可读。
    bar = new PulseStatusBar();
    bar.update(snapshotWith(), baseConfig(), 'ok');
    assert.equal(bar.debugState.color, undefined);
    assert.equal(bar.debugState.backgroundColor, undefined);
  });

  test('warning level triggers when either metric crosses the warning threshold', () => {
    bar = new PulseStatusBar();
    bar.update(snapshotWith({ memory: { total: 100, used: 85, available: 15, percent: 85 } }), baseConfig(), 'ok');
    assert.equal((bar.debugState.backgroundColor as vscode.ThemeColor)?.id, 'statusBarItem.warningBackground');
    assert.equal(bar.debugState.color, undefined);
  });

  test('critical level triggers on CPU alone and swaps in the warning icon', () => {
    bar = new PulseStatusBar();
    bar.update(snapshotWith({ cpu: { percent: 98, cores: 4 } }), baseConfig(), 'ok');
    assert.equal((bar.debugState.backgroundColor as vscode.ThemeColor)?.id, 'statusBarItem.errorBackground');
    assert.match(bar.debugState.text, /^\$\(warning\)/);
  });

  test('critical level triggers on memory alone even when CPU is normal', () => {
    bar = new PulseStatusBar();
    bar.update(snapshotWith({ memory: { total: 100, used: 99, available: 1, percent: 99 } }), baseConfig(), 'ok');
    assert.equal((bar.debugState.backgroundColor as vscode.ThemeColor)?.id, 'statusBarItem.errorBackground');
  });

  test('has no tooltip, so hovering over the status bar item shows nothing', () => {
    bar = new PulseStatusBar();
    bar.update(snapshotWith(), baseConfig(), 'ok');
    assert.equal(bar.debugState.tooltip, undefined);
  });

  test('showError sets an error icon', () => {
    bar = new PulseStatusBar();
    bar.showError('permission denied');
    assert.equal(bar.debugState.text, '$(circle-slash)');
  });

  // 悬浮 tooltip 已移除,磁盘/网络/GPU/Docker 只在趋势面板里能看到,
  // 点击就是这个面板在命令面板之外的唯一入口——所以这条绑定不能再被摘掉。
  test('clicking the status bar item opens the trend panel', () => {
    bar = new PulseStatusBar();
    assert.equal(bar.debugState.command, 'remotePulse.showTrend');
  });
});
