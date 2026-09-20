import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';

// 面板脚本是以模板字符串注入 webview 的:tsc 看不见里面,ESLint 也看不见里面。
// 少个括号不会有任何编译期信号,只会在用户点开面板的那一刻静默白屏。
// 这里做最低成本的一道闸:字符串必须能作为函数体解析。
function extractScript(name: string): string {
  const source = fs.readFileSync('src/webview/trendPanel.ts', 'utf8');
  const marker = `const ${name} = \``;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} 不在 trendPanel.ts 里,重命名了吗?`);
  const body = source.slice(start + marker.length);
  const end = body.indexOf('`;');
  assert.notEqual(end, -1, `${name} 的模板字符串没有正常闭合`);
  return body.slice(0, end);
}

test('PANEL_SCRIPT 语法可解析(webview 里跑的就是它)', () => {
  const script = extractScript('PANEL_SCRIPT');
  assert.ok(script.length > 1000, '脚本内容短得可疑');
  // new Function 只做解析,不执行,所以不需要 DOM。
  assert.doesNotThrow(() => new Function('acquireVsCodeApi', script));
});

test('PANEL_SCRIPT 不掺接 HTML,只用 textContent(注入面)', () => {
  const script = extractScript('PANEL_SCRIPT');
  // 模型里的挂载点/容器名/GPU 型号全部来自远程主机,可以被攻陷的远端控制;
  // 一旦哪天改用 innerHTML 拼字符串,面板就成了 XSS 的执行点。
  assert.doesNotMatch(script, /innerHTML\s*[+]?=/, 'webview 脚本里出现了 innerHTML 赋值');
  assert.doesNotMatch(script, /document\.write\(/, 'webview 脚本里出现了 document.write');
});
