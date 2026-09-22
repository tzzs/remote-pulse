import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { TrendPanel, TrendPayload } from '../../src/webview/trendPanel';

const EXTENSION_ID = 'tanzz.remote-pulse';

function payload(): TrendPayload {
  return {
    series: { timestamps: [1, 2, 3], cpu: [10, 20, 30], memory: [40, 50, 60] },
    latest: {
      cpu: { percent: 30, cores: 8, source: 'host' },
      memory: { total: 100, used: 60, available: 40, percent: 60, source: 'host' },
      disks: [{ mountPoint: '/', total: 100, used: 50, percent: 50 }],
      gpus: [],
      processes: [],
      uptimeSeconds: 3600,
    },
    thresholds: { warning: 80, critical: 95, gpuTempWarning: 80, gpuTempCritical: 90 },
    windowMinutes: 30,
  };
}

// 样式和脚本从 media/ 下的真实文件加载(不再是内联的模板字符串),所以外壳 HTML 里要有
// asWebviewUri 产出的地址,而且 CSP 必须同时放行 nonce(入口脚本)和 host 源
// (它静态 import 的 chart.js —— ES module 的 import 请求带不上 nonce)。
suite('TrendPanel (integration)', () => {
  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('opens without throwing and loads its assets from media/', () => {
    const extensionUri = vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri;
    TrendPanel.createOrShow(extensionUri, { label: 'dev-box (10.0.0.2)', user: 'tanzz' }, payload());
    assert.equal(TrendPanel.isOpen(), true);
  });

  test('refreshing an open panel does not throw', () => {
    const extensionUri = vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri;
    TrendPanel.createOrShow(extensionUri, { label: 'dev-box' }, payload());
    TrendPanel.refreshIfOpen({ label: 'dev-box' }, payload());
    assert.equal(TrendPanel.isOpen(), true);
  });

  test('refreshIfOpen is a no-op when no panel exists', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // 面板关闭后静态引用要被清掉,否则每轮采集都会往一个已销毁的 webview 发消息。
    TrendPanel.refreshIfOpen({ label: 'dev-box' }, payload());
  });
});
