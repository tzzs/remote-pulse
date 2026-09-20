import * as vscode from 'vscode';

/**
 * 采集失败/可用性探测过去全部被静默吞掉,用户报 issue 时无从诊断。
 * OutputChannel 按需创建、常驻很轻(不勾选指标就几乎没有输出),同一消息只报一次防刷屏。
 */
let channel: vscode.OutputChannel | undefined;
const seen = new Set<string>();

function ensureChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Remote Pulse');
  }
  return channel;
}

export function logInfo(message: string): void {
  ensureChannel().appendLine(`[info] ${message}`);
}

/** 同类错误每轮轮询都会重试,不去重会把输出刷满;去重后仍可通过 Show Log 看到首次现场。 */
export function logErrorOnce(context: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  const key = `${context}: ${detail}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  ensureChannel().appendLine(`[error] ${key}`);
}

export function showLog(): void {
  ensureChannel().show(true);
}

export function disposeLogChannel(): void {
  channel?.dispose();
  channel = undefined;
  seen.clear();
}
