import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'tanzz.remote-pulse';

suite('Extension activation (integration)', () => {
  test('is discoverable and activates without throwing', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be installed in the test host`);
    await ext!.activate();
    assert.equal(ext!.isActive, true);
  });

  test('registers both commands', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('remotePulse.showTrend'));
    assert.ok(commands.includes('remotePulse.refresh'));
  });

  test('refresh command runs without throwing', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
    await ext.activate();
    await vscode.commands.executeCommand('remotePulse.refresh');
  });

  test('declares the expected configuration defaults', () => {
    const cfg = vscode.workspace.getConfiguration('remotePulse');
    assert.equal(cfg.get('refreshInterval'), 2000);
    assert.equal(cfg.get('backgroundInterval'), 15000);
    assert.equal(cfg.get('heavyMetricInterval'), 10000);
    assert.equal(cfg.get('warningThreshold'), 80);
    assert.equal(cfg.get('criticalThreshold'), 95);
    assert.equal(cfg.get('template'), '$(pulse) CPU ${cpu}%  MEM ${mem}%');
    assert.equal(cfg.get('enableGpu'), true);
    assert.equal(cfg.get('enableDocker'), true);
    assert.equal(cfg.get('enableNetwork'), false);
    assert.equal(cfg.get('enableNotifications'), false);
    assert.deepEqual(cfg.get('diskMountPoints'), []);
    // 这个配置项已经在 status bar 改成同时展示 CPU+内存后删掉,这里顺带守一下不要被误加回来。
    assert.equal(cfg.get('statusBarMetric'), undefined);
  });
});
