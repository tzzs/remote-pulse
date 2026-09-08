import * as vscode from 'vscode';
import { AlertLevel, CpuStats, DiskStats, DockerContainerStats, DockerStats, GpuStats, MemoryStats, NetworkRate } from '../types';
import { calcAlertLevel } from '../store/statsStore';
import { formatBytes, formatRate, formatUptime } from '../util/sparkline';

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 系统命令输出(GPU 型号、容器名、挂载点)理论上可包含任意字符,插入 HTML 前一律转义。 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

export interface TrendSeries {
  timestamps: number[];
  cpu: number[];
  memory: number[];
}

export interface TrendLatest {
  cpu?: CpuStats;
  memory?: MemoryStats;
  disks: DiskStats[];
  network?: NetworkRate;
  gpus: GpuStats[];
  docker?: DockerStats;
  uptimeSeconds?: number;
}

export interface TrendPayload {
  series: TrendSeries;
  latest?: TrendLatest;
  thresholds: { warning: number; critical: number };
}

/**
 * 趋势面板按需创建、按需销毁,不常驻内存(retainContextWhenHidden: false)。
 * 关闭后再次打开会重新创建并注入最新历史数据,不留痕迹。
 */
export class TrendPanel {
  private static current: TrendPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static createOrShow(hostLabel: string, payload: TrendPayload): void {
    if (TrendPanel.current) {
      TrendPanel.current.panel.reveal();
      TrendPanel.current.update(hostLabel, payload);
      return;
    }
    TrendPanel.current = new TrendPanel(hostLabel, payload);
  }

  static isOpen(): boolean {
    return TrendPanel.current !== undefined;
  }

  static refreshIfOpen(hostLabel: string, payload: TrendPayload): void {
    TrendPanel.current?.update(hostLabel, payload);
  }

  private constructor(hostLabel: string, payload: TrendPayload) {
    this.panel = vscode.window.createWebviewPanel('remotePulseTrend', vscode.l10n.t('Remote Pulse Trend'), vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: false,
    });
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.update(hostLabel, payload);
  }

  private update(hostLabel: string, payload: TrendPayload): void {
    this.panel.title = `Remote Pulse — ${hostLabel}`;
    this.panel.webview.html = this.renderHtml(hostLabel, payload);
  }

  private renderHtml(hostLabel: string, payload: TrendPayload): string {
    const csp = this.panel.webview.cspSource;
    const n = nonce();
    const { series, latest, thresholds } = payload;
    const dataJson = JSON.stringify(series).replace(/</g, '\\u003c');
    const hostLabelSafe = escapeHtml(hostLabel);
    const updatedAt = new Intl.DateTimeFormat(vscode.env.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());

    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${n}';" />
  <title>${vscode.l10n.t('Remote Pulse Trend')}</title>
  <style>${this.css()}</style>
</head>
<body>
  <header class="page-header">
    <h1>${hostLabelSafe}</h1>
    <div class="updated">${vscode.l10n.t('Updated {0}', updatedAt)}</div>
  </header>

  ${latest ? this.renderBody(series, latest, thresholds) : this.renderEmpty()}

  <script nonce="${n}">
    const series = ${dataJson};
    const canvas = document.getElementById('chart');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      const style = getComputedStyle(document.body);
      const cpuColor = style.getPropertyValue('--cpu-color').trim() || '#3794ff';
      const memColor = style.getPropertyValue('--mem-color').trim() || '#f5a623';
      const gridColor = style.getPropertyValue('--grid-color').trim() || 'rgba(128,128,128,0.25)';

      function plot(values, color) {
        if (values.length < 2) return;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        ctx.beginPath();
        values.forEach((v, i) => {
          const x = (w * i) / (values.length - 1);
          const y = h - (Math.min(100, Math.max(0, v)) / 100) * h;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.stroke();
        const lastV = values[values.length - 1];
        const lastY = h - (Math.min(100, Math.max(0, lastV)) / 100) * h;
        ctx.beginPath();
        ctx.arc(w, lastY, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }

      function draw() {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
          const y = (h / 4) * i;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }

        plot(series.cpu, cpuColor);
        plot(series.memory, memColor);
      }

      draw();
      window.addEventListener('resize', draw);
    }
  </script>
</body>
</html>`;
  }

  private renderEmpty(): string {
    return `<p class="empty-note">${vscode.l10n.t('Not enough history data yet. Please wait a few seconds and reopen.')}</p>`;
  }

  private renderBody(series: TrendSeries, latest: TrendLatest, thresholds: { warning: number; critical: number }): string {
    return [
      this.renderStatGrid(latest, thresholds),
      this.renderChartCard(series),
      this.renderGpuSection(latest.gpus, thresholds),
      this.renderDockerSection(latest.docker),
    ]
      .filter(Boolean)
      .join('\n');
  }

  private renderStatGrid(latest: TrendLatest, thresholds: { warning: number; critical: number }): string {
    const cards: string[] = [];

    if (latest.cpu) {
      const level = calcAlertLevel(latest.cpu.percent, thresholds.warning, thresholds.critical);
      cards.push(this.statCard('CPU', `${Math.round(latest.cpu.percent)}%`, vscode.l10n.t('{0} cores', latest.cpu.cores), latest.cpu.percent, level));
    }
    if (latest.memory) {
      const level = calcAlertLevel(latest.memory.percent, thresholds.warning, thresholds.critical);
      cards.push(
        this.statCard(
          vscode.l10n.t('Memory'),
          `${Math.round(latest.memory.percent)}%`,
          `${formatBytes(latest.memory.used)} / ${formatBytes(latest.memory.total)}`,
          latest.memory.percent,
          level,
        ),
      );
    }
    for (const disk of latest.disks) {
      const level = calcAlertLevel(disk.percent, thresholds.warning, thresholds.critical);
      cards.push(
        this.statCard(
          escapeHtml(disk.mountPoint),
          `${Math.round(disk.percent)}%`,
          `${formatBytes(disk.used)} / ${formatBytes(disk.total)}`,
          disk.percent,
          level,
        ),
      );
    }
    if (latest.network) {
      cards.push(
        this.statCard(vscode.l10n.t('Network'), `↓ ${formatRate(latest.network.rxRate)}`, `↑ ${formatRate(latest.network.txRate)}`, undefined, 'normal'),
      );
    }
    if (latest.uptimeSeconds !== undefined) {
      cards.push(this.statCard(vscode.l10n.t('Uptime'), formatUptime(latest.uptimeSeconds), '', undefined, 'normal'));
    }

    return cards.length ? `<section class="stat-grid">${cards.join('')}</section>` : '';
  }

  private statCard(label: string, value: string, sub: string, percent: number | undefined, level: AlertLevel): string {
    const bar = percent !== undefined ? `<div class="stat-bar"><div class="stat-bar-fill" style="width:${Math.min(100, Math.max(0, percent))}%"></div></div>` : '';
    return `<div class="stat-card level-${level}">
      <div class="stat-label" title="${label}">${label}</div>
      <div class="stat-value">${value}</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
      ${bar}
    </div>`;
  }

  private renderChartCard(series: TrendSeries): string {
    const hasData = series.cpu.length > 0 || series.memory.length > 0;
    return `<section class="chart-card">
      <div class="chart-header">
        <h2 class="section-title">${vscode.l10n.t('past 30 minutes')}</h2>
        <div class="legend">
          <span><i class="dot" style="background:var(--cpu-color)"></i>CPU</span>
          <span><i class="dot" style="background:var(--mem-color)"></i>${vscode.l10n.t('Memory')}</span>
        </div>
      </div>
      ${
        hasData
          ? `<div class="chart-body">
        <div class="y-axis"><span>100%</span><span>50%</span><span>0%</span></div>
        <canvas id="chart"></canvas>
      </div>`
          : `<p class="empty-note">${vscode.l10n.t('Not enough history data yet. Please wait a few seconds and reopen.')}</p>`
      }
    </section>`;
  }

  private renderGpuSection(gpus: GpuStats[], thresholds: { warning: number; critical: number }): string {
    if (!gpus.length) {
      return '';
    }
    const cards = gpus
      .map(gpu => {
        const utilLevel = calcAlertLevel(gpu.utilizationPercent, thresholds.warning, thresholds.critical);
        const vramPercent = gpu.memoryTotalMb > 0 ? (gpu.memoryUsedMb / gpu.memoryTotalMb) * 100 : 0;
        const vramLevel = calcAlertLevel(vramPercent, thresholds.warning, thresholds.critical);
        const tempLevel = calcAlertLevel(gpu.temperatureC, thresholds.warning, thresholds.critical);
        const title = `GPU #${gpu.index}${gpu.name ? ` · ${escapeHtml(gpu.name)}` : ''}`;
        return `<div class="gpu-card">
          <div class="gpu-card-header">${title}</div>
          ${this.metricRow(vscode.l10n.t('Utilization'), gpu.utilizationPercent, `${Math.round(gpu.utilizationPercent)}%`, utilLevel)}
          ${this.metricRow(vscode.l10n.t('VRAM'), vramPercent, `${gpu.memoryUsedMb}/${gpu.memoryTotalMb} MB`, vramLevel)}
          ${this.metricRow(vscode.l10n.t('Temp'), undefined, `${gpu.temperatureC}°C`, tempLevel)}
        </div>`;
      })
      .join('');
    return `<section>
      <h2 class="section-title">GPU</h2>
      <div class="gpu-grid">${cards}</div>
    </section>`;
  }

  private metricRow(label: string, percent: number | undefined, value: string, level: AlertLevel): string {
    const bar = percent !== undefined ? `<div class="metric-bar"><div class="metric-bar-fill level-${level}" style="width:${Math.min(100, Math.max(0, percent))}%"></div></div>` : '<div class="metric-bar"></div>';
    return `<div class="metric-row">
      <span class="metric-label">${label}</span>
      ${bar}
      <span class="metric-value level-${level}">${value}</span>
    </div>`;
  }

  private renderDockerSection(docker: DockerStats | undefined): string {
    if (!docker) {
      return '';
    }
    const summary = `<p class="section-sub">${vscode.l10n.t('Running containers: {0}', docker.containerCount)}</p>`;
    const body = docker.containers.length
      ? `<table class="docker-table">
          <thead><tr><th></th><th>CPU</th><th>${vscode.l10n.t('Memory')}</th></tr></thead>
          <tbody>${docker.containers.map(c => this.dockerRow(c)).join('')}</tbody>
        </table>`
      : `<p class="empty-note">${vscode.l10n.t('No containers running')}</p>`;
    return `<section>
      <h2 class="section-title">${vscode.l10n.t('Docker containers')}</h2>
      ${summary}
      ${body}
    </section>`;
  }

  private dockerRow(c: DockerContainerStats): string {
    return `<tr><td>${escapeHtml(c.name)}</td><td>${c.cpuPercent.toFixed(1)}%</td><td>${formatBytes(c.memoryUsedBytes)}</td></tr>`;
  }

  private css(): string {
    return `
    * { box-sizing: border-box; }
    :root {
      --cpu-color: var(--vscode-charts-blue, #3794ff);
      --mem-color: var(--vscode-charts-orange, #f5a623);
      --grid-color: rgba(128, 128, 128, 0.25);
      --card-border: var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
      --card-bg: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.06));
      --level-normal: var(--vscode-charts-green, #89d185);
      --level-warning: var(--vscode-charts-yellow, #cca700);
      --level-critical: var(--vscode-charts-red, #f14c4c);
    }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 16px 20px 24px;
    }
    .page-header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px; margin-bottom: 14px; }
    h1 { font-size: 15px; font-weight: 600; margin: 0; }
    .updated { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-descriptionForeground); margin: 20px 0 8px; }
    section:first-of-type .section-title { margin-top: 0; }

    .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
    .stat-card { border: 1px solid var(--card-border); border-radius: 6px; background: var(--card-bg); padding: 10px 12px; min-width: 0; }
    .stat-label { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px; }
    .stat-value { font-size: 20px; font-weight: 600; line-height: 1.2; }
    .stat-card.level-warning .stat-value { color: var(--level-warning); }
    .stat-card.level-critical .stat-value { color: var(--level-critical); }
    .stat-sub { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    .stat-bar { height: 4px; border-radius: 2px; background: rgba(128, 128, 128, 0.2); margin-top: 8px; overflow: hidden; }
    .stat-bar-fill { height: 100%; border-radius: 2px; background: var(--level-normal); }
    .stat-card.level-warning .stat-bar-fill { background: var(--level-warning); }
    .stat-card.level-critical .stat-bar-fill { background: var(--level-critical); }

    .chart-card { border: 1px solid var(--card-border); border-radius: 6px; background: var(--card-bg); padding: 14px 16px; }
    .chart-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .chart-header .section-title { margin: 0; }
    .legend { display: flex; gap: 14px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .legend .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 4px; }
    .chart-body { display: flex; gap: 8px; }
    .y-axis { display: flex; flex-direction: column; justify-content: space-between; font-size: 10px; color: var(--vscode-descriptionForeground); padding: 2px 0; }
    canvas#chart { flex: 1; width: 100%; height: 200px; }

    .gpu-grid { display: flex; flex-direction: column; gap: 8px; }
    .gpu-card { border: 1px solid var(--card-border); border-radius: 6px; background: var(--card-bg); padding: 10px 12px; }
    .gpu-card-header { font-size: 12px; font-weight: 600; margin-bottom: 8px; }
    .metric-row { display: flex; align-items: center; gap: 8px; font-size: 11px; margin-bottom: 6px; }
    .metric-row:last-child { margin-bottom: 0; }
    .metric-label { width: 56px; flex-shrink: 0; color: var(--vscode-descriptionForeground); }
    .metric-bar { flex: 1; height: 4px; border-radius: 2px; background: rgba(128, 128, 128, 0.2); overflow: hidden; }
    .metric-bar-fill { height: 100%; background: var(--level-normal); }
    .metric-bar-fill.level-warning { background: var(--level-warning); }
    .metric-bar-fill.level-critical { background: var(--level-critical); }
    .metric-value { flex-shrink: 0; text-align: right; min-width: 64px; }
    .metric-value.level-warning { color: var(--level-warning); }
    .metric-value.level-critical { color: var(--level-critical); }

    table.docker-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    table.docker-table th { text-align: left; font-weight: 500; font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px 8px; border-bottom: 1px solid var(--card-border); }
    table.docker-table td { padding: 5px 8px; border-bottom: 1px solid rgba(128, 128, 128, 0.12); }
    table.docker-table td:not(:first-child), table.docker-table th:not(:first-child) { text-align: right; white-space: nowrap; }

    .empty-note, .section-sub { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
    `;
  }

  private dispose(): void {
    TrendPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
