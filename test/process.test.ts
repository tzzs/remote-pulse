import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProcStat, calcProcessCpuPercent, isPid } from '../src/collectors/process';

/**
 * 按 man proc 的字段编号拼一行 /proc/[pid]/stat:
 * 1=pid 2=comm 3=state … 14=utime 15=stime … 24=rss。
 * comm 之后的第一个字段就是 state,所以 fields[0] 对应编号 3,编号 N 对应 fields[N - 3]。
 */
function statLine(name: string, utime: number, stime: number, rssPages: number): string {
  const fields = new Array(50).fill('0');
  fields[0] = 'S';
  fields[14 - 3] = String(utime);
  fields[15 - 3] = String(stime);
  fields[24 - 3] = String(rssPages);
  return `123 (${name}) ${fields.join(' ')}`;
}

test('parseProcStat 取出 utime+stime 与 rss', () => {
  const sample = parseProcStat(123, statLine('node', 100, 50, 2048));
  assert.ok(sample);
  assert.equal(sample.name, 'node');
  assert.equal(sample.cpuTicks, 150);
  assert.equal(sample.rssPages, 2048);
});

test('parseProcStat 正确处理含空格的进程名', () => {
  // 回归:按空格 split 整行会把 "Web Content" 切成两半,后面所有字段的下标全错位。
  const sample = parseProcStat(1, statLine('Web Content', 10, 20, 100));
  assert.ok(sample);
  assert.equal(sample.name, 'Web Content');
  assert.equal(sample.cpuTicks, 30);
});

test('parseProcStat 正确处理含括号的进程名', () => {
  const sample = parseProcStat(1, statLine('(sd-pam)', 1, 2, 3));
  assert.ok(sample);
  assert.equal(sample.name, '(sd-pam)');
  assert.equal(sample.cpuTicks, 3);
});

test('parseProcStat 对畸形行返回 undefined,不抛错打断整轮采集', () => {
  assert.equal(parseProcStat(1, 'garbage without parens'), undefined);
});

test('calcProcessCpuPercent 与 CPU 总占用同口径:分母是全部核心', () => {
  // 1 秒内消耗 100 tick(= 1 秒 CPU 时间),8 核机器上就是 12.5%。
  assert.equal(calcProcessCpuPercent(0, 100, 1000, 8), 12.5);
  assert.equal(calcProcessCpuPercent(0, 100, 1000, 1), 100);
});

test('calcProcessCpuPercent 对零/负的时间间隔返回 0,不除零', () => {
  assert.equal(calcProcessCpuPercent(0, 100, 0, 8), 0);
  assert.equal(calcProcessCpuPercent(0, 100, -10, 8), 0);
});

test('isPid 只认纯数字目录,/proc 下的 self、net 之类不会被当成进程', () => {
  assert.equal(isPid('1234'), true);
  assert.equal(isPid('self'), false);
  assert.equal(isPid('net'), false);
});
