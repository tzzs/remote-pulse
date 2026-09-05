import * as vscode from 'vscode';

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export interface TrendSeries {
  timestamps: number[];
  cpu: number[];
  memory: number[];
}

/**
 * 趋势面板按需创建、按需销毁,不常驻内存(retainContextWhenHidden: false)。
 * 关闭后再次点击状态栏会重新创建并注入最新历史数据,不留痕迹。
 */
export class TrendPanel {
  private static current: TrendPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static createOrShow(hostLabel: string, series: TrendSeries): void {
    if (TrendPanel.current) {
      TrendPanel.current.panel.reveal();
      TrendPanel.current.update(hostLabel, series);
      return;
    }
    TrendPanel.current = new TrendPanel(hostLabel, series);
  }

  static isOpen(): boolean {
    return TrendPanel.current !== undefined;
  }

  static refreshIfOpen(hostLabel: string, series: TrendSeries): void {
    TrendPanel.current?.update(hostLabel, series);
  }

  private constructor(hostLabel: string, series: TrendSeries) {
    this.panel = vscode.window.createWebviewPanel('remotePulseTrend', vscode.l10n.t('Remote Pulse Trend'), vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: false,
    });
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.update(hostLabel, series);
  }

  private update(hostLabel: string, series: TrendSeries): void {
    this.panel.title = `Remote Pulse — ${hostLabel}`;
    this.panel.webview.html = this.renderHtml(hostLabel, series);
  }

  private renderHtml(hostLabel: string, series: TrendSeries): string {
    const csp = this.panel.webview.cspSource;
    const n = nonce();
    const dataJson = JSON.stringify(series).replace(/</g, '\\u003c');
    const hostLabelSafe = hostLabel.replace(/[<>&]/g, '');

    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${n}';" />
  <title>${vscode.l10n.t('Remote Pulse Trend')}</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
    h2 { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
    .legend { display: flex; gap: 16px; font-size: 12px; margin-bottom: 8px; }
    .legend span { display: inline-flex; align-items: center; gap: 4px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .cpu-dot { background: #3794ff; }
    .mem-dot { background: #f5a623; }
    canvas { width: 100%; height: 260px; }
    .empty { opacity: 0.7; font-size: 12px; }
  </style>
</head>
<body>
  <h2>${hostLabelSafe} — ${vscode.l10n.t('past 30 minutes')}</h2>
  <div class="legend">
    <span><i class="dot cpu-dot"></i>CPU %</span>
    <span><i class="dot mem-dot"></i>${vscode.l10n.t('Memory')} %</span>
  </div>
  <canvas id="chart" width="800" height="260"></canvas>
  <p id="empty-hint" class="empty" style="display:none;">${vscode.l10n.t('Not enough history data yet. Please wait a few seconds and reopen.')}</p>
  <script nonce="${n}">
    const series = ${dataJson};
    const canvas = document.getElementById('chart');
    const ctx = canvas.getContext('2d');

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);

      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      if (!series.cpu.length && !series.memory.length) {
        document.getElementById('empty-hint').style.display = 'block';
        return;
      }

      const padding = 24;
      const plotW = w - padding * 2;
      const plotH = h - padding * 2;

      ctx.strokeStyle = 'rgba(128,128,128,0.3)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = padding + (plotH / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(w - padding, y);
        ctx.stroke();
      }

      function plot(values, color) {
        if (values.length < 2) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        values.forEach((v, i) => {
          const x = padding + (plotW * i) / (values.length - 1);
          const y = padding + plotH - (Math.min(100, Math.max(0, v)) / 100) * plotH;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      plot(series.cpu, '#3794ff');
      plot(series.memory, '#f5a623');
    }

    draw();
    window.addEventListener('resize', draw);
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    TrendPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
