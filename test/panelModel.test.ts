import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, HostInfo, TrendPayload } from '../src/webview/panelModel';

// 模型层不 import vscode,翻译函数直接以恒等注入,断言看英文原文即可。
const loc = { locale: 'en', t: (m: string, ...args: (string | number)[]) => m + (args.length ? `|${args.join(',')}` : '') };

const host: HostInfo = { label: 'dev-01 [WSL:ubuntu] (10.0.0.2)', user: 'dev' };

function payload(overrides: Partial<TrendPayload> = {}): TrendPayload {
  return {
    series: { timestamps: [1, 2], cpu: [10, 20], memory: [30, 40] },
    latest: {
      cpu: { percent: 42, cores: 8 },
      memory: { total: 1000, used: 640, available: 360, percent: 64 },
      disks: [{ mountPoint: '/', total: 100, used: 97, percent: 97 }],
      gpus: [],
      uptimeSeconds: 3600,
    },
    thresholds: { warning: 80, critical: 95 },
    ...overrides,
  };
}

test('splitHostLabel: 主名与括号内 IP 分离,WSL 标记留在主名里', () => {
  const m = buildModel(host, payload(), loc);
  assert.equal(m.host.name, 'dev-01 [WSL:ubuntu]');
  assert.equal(m.host.meta, '10.0.0.2');
  assert.equal(m.host.user, 'dev');
});

test('System 区块含 CPU 行,Storage 满盘行按 critical 着色', () => {
  const m = buildModel(host, payload(), loc);
  const system = m.groups.find(g => g.kind === 'metrics' && g.title.startsWith('System'))!;
  assert.ok(system);
  if (system.kind !== 'metrics') return;
  const cpuRow = system.rows.find(r => r.label === 'CPU');
  assert.ok(cpuRow);
  assert.equal(cpuRow.value, '42%');
  const storage = m.groups.find(g => g.title === 'Storage')!;
  assert.ok(storage.kind === 'metrics');
  assert.equal(storage.rows[0].level, 'critical');
});

test('chart 图例按 series 里存在的线生成,key 与 trendChartMetrics 一致', () => {
  const m = buildModel(host, payload(), loc);
  const chart = m.groups.find(g => g.kind === 'chart')!;
  assert.ok(chart.kind === 'chart');
  assert.deepEqual(chart.legend.map(l => l.key), ['cpu', 'memory']);
  // 图例当前值取数组末点,而不是 latest.*
  assert.equal(chart.legend[0].value, '20%');
  // 读屏替身 = 图表标题 + 线名,全部走注入的 t,webview 侧不再写死英文
  assert.equal(m.chartAriaLabel, '{0} · past 30 minutes|Trend: CPU / Memory');
});

test('未勾选的线不出现在图例里,memory 单勾也能工作', () => {
  const m = buildModel(host, payload({ series: { timestamps: [1, 2], memory: [30, 40] } }), loc);
  const chart = m.groups.find(g => g.kind === 'chart')!;
  assert.ok(chart.kind === 'chart');
  assert.deepEqual(chart.legend.map(l => l.key), ['memory']);
});

test('GPU 区块:无数据但探测为 not_installed 时给出提示行而不是消失', () => {
  const m = buildModel(host, payload({ availability: { gpu: 'not_installed' } }), loc);
  const gpu = m.groups.find(g => g.title === 'GPU')!;
  assert.ok(gpu.kind === 'metrics');
  assert.equal(gpu.rows.length, 1);
  assert.equal(gpu.rows[0].hint, true);
});

test('GPU 区块:有数据时逐卡输出 利用率/显存/温度 三行子项', () => {
  const withGpu = payload();
  withGpu.latest!.gpus = [{ index: 0, name: 'A100', utilizationPercent: 55, memoryUsedMb: 40000, memoryTotalMb: 80000, temperatureC: 70 }];
  const m = buildModel(host, withGpu, loc);
  const gpu = m.groups.find(g => g.title === 'GPU')!;
  assert.ok(gpu.kind === 'metrics');
  assert.equal(gpu.rows.length, 4);
  assert.equal(gpu.rows[1].level, 'normal');
  assert.equal(gpu.rows[2].percent, 50);
});

test('Docker 表格:内存列带占 limit 的百分比并按阈值着色', () => {
  const withDocker = payload();
  withDocker.latest!.docker = {
    containerCount: 2,
    containers: [
      { id: 'a', name: 'web', cpuPercent: 12.5, memoryUsedBytes: 100, memoryLimitBytes: 1000 },
      { id: 'b', name: 'db', cpuPercent: 1, memoryUsedBytes: 970, memoryLimitBytes: 1000 },
    ],
  };
  const m = buildModel(host, withDocker, loc);
  const docker = m.groups.find(g => g.kind === 'table')!;
  assert.ok(docker.kind === 'table');
  assert.equal(docker.badge, '2');
  assert.equal(docker.rows[0][2], '100 B 10%');
  assert.equal(docker.levels[1], 'critical');
});

test('Docker 无权限时表格给出空态提示而不是无声消失', () => {
  const m = buildModel(host, payload({ availability: { docker: 'no_permission' } }), loc);
  const docker = m.groups.find(g => g.kind === 'table')!;
  assert.ok(docker.kind === 'table');
  assert.equal(docker.rows.length, 0);
  assert.ok(docker.emptyHint && docker.emptyHint.startsWith('Docker metrics unavailable'));
});

test('latest 缺失时只有 chart 区块,不抛错', () => {
  const m = buildModel(host, { series: { timestamps: [] }, thresholds: { warning: 80, critical: 95 } }, loc);
  assert.deepEqual(m.groups.map(g => g.kind), ['chart']);
});
