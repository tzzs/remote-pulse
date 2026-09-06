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

  // 这个测试宿主本身就是一个本地(非远程)窗口,vscode.env.remoteName 恒为 undefined,
  // 所以这里验证的正是"非远程时不应该启动监控"这条要求本身——不是巧合失败,是故意断言这个行为。
  test('does not start monitoring outside a remote window', async () => {
    assert.equal(vscode.env.remoteName, undefined, 'the integration test host is expected to be a local, non-remote window');
    const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
    const api = await ext.activate();
    assert.deepEqual(api, { monitoring: false });
  });

  test('does not register commands outside a remote window', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.equal(commands.includes('remotePulse.showTrend'), false);
    assert.equal(commands.includes('remotePulse.refresh'), false);
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
