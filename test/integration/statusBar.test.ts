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

  test('normal level renders green text and no background', () => {
    bar = new PulseStatusBar();
    bar.update('host', snapshotWith(), baseConfig(), 'ok');
    assert.equal((bar.debugState.color as vscode.ThemeColor)?.id, 'charts.green');
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

  test('tooltip renders the host, CPU and memory lines', () => {
    bar = new PulseStatusBar();
    bar.update('host-1', snapshotWith(), baseConfig(), 'ok');
    const tooltip = (bar.debugState.tooltip as vscode.MarkdownString).value;
    assert.match(tooltip, /Remote host: host-1/);
    assert.match(tooltip, /CPU\s+.*10%\s+\(4 cores\)/);
    assert.match(tooltip, /Memory\s+.*10%/);
  });

  test('each disk renders as its own list item, separated by a markdown hard break', () => {
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
    const tooltip = (bar.debugState.tooltip as vscode.MarkdownString).value;
    assert.match(tooltip, /- \/mnt\/c {2}87%/);
    assert.match(tooltip, /- \/mnt\/j {2}86%/);
    const between = tooltip.slice(tooltip.indexOf('/mnt/c'), tooltip.indexOf('/mnt/j'));
    assert.ok(between.includes('  \n'), 'disk entries should be separated by a markdown hard break, not run together');
  });

  test('the tooltip sparkline is capped to the samples it is given, not unbounded', () => {
    bar = new PulseStatusBar();
    const cpuHistory = Array.from({ length: 20 }, (_, i) => i * 5);
    bar.update('host', snapshotWith(), baseConfig(), 'ok', { cpu: cpuHistory, memory: [] });
    const tooltip = (bar.debugState.tooltip as vscode.MarkdownString).value;
    const cpuLine = tooltip.split('  \n').find(line => line.startsWith('CPU'));
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
});
