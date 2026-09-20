/** 采集器/模型层不能 import vscode(否则纯 `node --test` 跑不到),诊断文本在这里统一取。 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
