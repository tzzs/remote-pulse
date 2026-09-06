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
    bar.update('host', { timestamp: Date.now() }, baseConfig(), 'ok');
    assert.equal(bar.debugState.text, '$(sync~spin)');
  });

  test('shows both CPU and memory using the configured template', () => {
    bar = new PulseStatusBar();
    bar.update('host', snapshotWith({ cpu: { percent: 12, cores: 8 }, memory: { total: 100, used: 34, available: 66, percent: 34 } }), baseConfig(), 'ok');
    assert.equal(bar.debugState.text, '$(pulse) CPU 12%  MEM 34%');
  });

  test('normal level leaves color/background untouched, inheriting the theme default', () => {
    // 状态栏背景会被 Vim 模式插件、Remote 连接等场景动态改写,而 vscode API 没有办法读取
    // "当前实际背景色",所以正常态特意不设自定义前景色——不设置才能始终跟随主题的
    // statusBar.foreground,不会在某些背景下变得不可读。
    bar = new PulseStatusBar();
    bar.update('host', snapshotWith(), baseConfig(), 'ok');
    assert.equal(bar.debugState.color, undefined);
    assert.equal(bar.debugState.backgroundColor, undefined);
  });

  test('warning level triggers when either metric crosses the warning threshold', () => {
    bar = new PulseStatusBar();
    bar.update('host', snapshotWith({ memory: { total: 100, used: 85, available: 15, percent: 85 } }), baseConfig(), 'ok');
    assert.equal((bar.debugState.backgroundColor as vscode.ThemeColor)?.id, 'statusBarItem.warningBackground');
    assert.equal(bar.debugState.color, undefined);
  });

  test('critical level triggers on CPU alone and swaps in the warning icon', () => {
    bar = new PulseStatusBar();
    bar.update('host', snapshotWith({ cpu: { percent: 98, cores: 4 } }), baseConfig(), 'ok');
    assert.equal((bar.debugState.backgroundColor as vscode.ThemeColor)?.id, 'statusBarItem.errorBackground');
    assert.match(bar.debugState.text, /^\$\(warning\)/);
  });

  test('critical level triggers on memory alone even when CPU is normal', () => {
    bar = new PulseStatusBar();
    bar.update('host', snapshotWith({ memory: { total: 100, used: 99, available: 1, percent: 99 } }), baseConfig(), 'ok');
    assert.equal((bar.debugState.backgroundColor as vscode.ThemeColor)?.id, 'statusBarItem.errorBackground');
  });

  test('tooltip is a MarkdownString and its identity never changes across updates (avoids hover flicker)', () => {
    bar = new PulseStatusBar();
    const before = bar.debugState.tooltip;
    assert.ok(before instanceof vscode.MarkdownString);
    bar.update('host', snapshotWith(), baseConfig(), 'ok');
    const after = bar.debugState.tooltip;
    assert.equal(before, after, 'item.tooltip should be the same object reference, only its .value should change');
  });

  test('tooltip renders the host, CPU and memory inside an aligned code block', () => {
    bar = new PulseStatusBar();
    bar.update('host-1', snapshotWith(), baseConfig(), 'ok');
    const tooltip = (bar.debugState.tooltip as vscode.MarkdownString).value;
    assert.match(tooltip, /Remote host: host-1/);
    assert.match(tooltip, /```\n[\s\S]*```/, 'the metric rows should be wrapped in a fenced code block for monospace alignment');
    assert.match(tooltip, /^CPU\s+.*10%.*\(4 cores\)/m);
    assert.match(tooltip, /^Memory\s+.*10%/m);
  });

  test('every row value starts at the same column, regardless of label length', () => {
    bar = new PulseStatusBar();
    bar.update(
      'host',
      snapshotWith({ gpus: [{ index: 0, name: 'RTX 5060 Ti', utilizationPercent: 6, memoryUsedMb: 2293, memoryTotalMb: 16311, temperatureC: 47 }] }),
      baseConfig(),
      'ok',
    );
    const tooltip = (bar.debugState.tooltip as vscode.MarkdownString).value;
    const body = tooltip.split('```')[1].trim().split('\n');
    const valueColumns = body.map(line => {
      // 非贪婪匹配到"标签部分"(可能内部带单个空格,比如 "GPU #0"),直到遇到 2+ 个空格的真正填充段。
      const match = line.match(/^(.+?\S)( {2,})(?=\S)/);
      assert.ok(match, `row should have a label followed by at least two spaces before its value: "${line}"`);
      return match![1].length + match![2].length;
    });
    assert.ok(valueColumns.every(col => col === valueColumns[0]), `expected every row's value to start at the same column, got: ${JSON.stringify(valueColumns)}`);
  });

  test('each disk gets its own row instead of running together on one line', () => {
    bar = new PulseStatusBar();
    bar.update(
      'host',
      snapshotWith({
        disks: [
          { mountPoint: '/mnt/c', total: 100, used: 87, percent: 87 },
          { mountPoint: '/mnt/j', total: 100, used: 86, percent: 86 },
        ],
      }),
      baseConfig(),
      'ok',
    );
    const lines = (bar.debugState.tooltip as vscode.MarkdownString).value.split('\n');
    const cLine = lines.find(l => l.includes('/mnt/c'));
    const jLine = lines.find(l => l.includes('/mnt/j'));
    assert.ok(cLine && /87%/.test(cLine));
    assert.ok(jLine && /86%/.test(jLine));
    assert.notEqual(cLine, jLine, 'each disk should be a separate row, not sharing a line');
  });

  test('GPU utilization, VRAM and temperature each get their own row, VRAM/Temp indented under it', () => {
    bar = new PulseStatusBar();
    bar.update('host', snapshotWith({ gpus: [{ index: 0, name: 'RTX 5060 Ti', utilizationPercent: 6, memoryUsedMb: 2293, memoryTotalMb: 16311, temperatureC: 47 }] }), baseConfig(), 'ok');
    const lines = (bar.debugState.tooltip as vscode.MarkdownString).value.split('\n');
    const utilLine = lines.find(l => l.includes('GPU #0'));
    const vramLine = lines.find(l => l.includes('VRAM'));
    const tempLine = lines.find(l => l.includes('Temp'));
    assert.ok(utilLine && /RTX 5060 Ti/.test(utilLine) && /6%/.test(utilLine));
    assert.ok(vramLine?.startsWith('  ') && /2293\/16311 MB/.test(vramLine), 'VRAM should be an indented sub-row under the GPU line');
    assert.ok(tempLine?.startsWith('  ') && /47°C/.test(tempLine), 'Temp should be an indented sub-row under the GPU line');
  });

  test('the tooltip sparkline is capped to the samples it is given, not unbounded', () => {
    bar = new PulseStatusBar();
    const cpuHistory = Array.from({ length: 20 }, (_, i) => i * 5);
    bar.update('host', snapshotWith(), baseConfig(), 'ok', { cpu: cpuHistory, memory: [] });
    const tooltip = (bar.debugState.tooltip as vscode.MarkdownString).value;
    const cpuLine = tooltip.split('\n').find(line => line.startsWith('CPU'));
    assert.ok(cpuLine);
    const sparkChars = cpuLine!.match(/[▁▂▃▄▅▆▇█]/g) ?? [];
    assert.equal(sparkChars.length, cpuHistory.length);
  });

  test('showError sets an error icon and explains the reason in the tooltip', () => {
    bar = new PulseStatusBar();
    bar.showError('permission denied');
    assert.equal(bar.debugState.text, '$(circle-slash)');
    assert.match((bar.debugState.tooltip as vscode.MarkdownString).value, /permission denied/);
  });

  test('clicking the status bar item does nothing for now (the trend panel entry point is disabled)', () => {
    bar = new PulseStatusBar();
    assert.equal(bar.debugState.command, undefined);
  });
});
