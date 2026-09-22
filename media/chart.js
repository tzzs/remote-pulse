// 趋势图的纯计算部分:不碰 DOM,因此可以在 Node 里直接单元测试(test/chart.test.mjs)。
// 早先这些函数和渲染代码一起挤在扩展侧的一个模板字符串里——既不过类型检查也没法测,
// 而 niceMax 的取整阶梯、downsample 的桶边界恰恰是最容易算错、也最值得回归测试的部分。

/**
 * 把窗口内的原始峰值撑到一个好看的刻度上限——按 1024 进制取整,这样轴标签显示出来才是
 * 整数的 KB/MB(比如 "2.0 MB/s"),跟 formatRate 的二进制单位对得上,不会出现 "1.9 MB/s"
 * 这种十进制取整后被二进制单位换算弄得不整的数。阶梯只到 10 会漏掉 10~1024 这一整段——
 * 比如峰值 878KB/s,除一次 1024 后 v=878,不满足 <=10 里任何一档,原逻辑会直接落到"10",
 * 算出来的上限(10KB)反而比峰值本身还小,把线整条顶穿画到轴外面,看着像那条线消失了。
 * 阶梯延伸到 1024 才能覆盖任意峰值。
 */
export function niceMax(raw) {
  if (!isFinite(raw) || raw <= 0) return 1;
  let i = 0;
  let v = raw;
  while (v >= 1024 && i < 4) { v /= 1024; i++; }
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1024];
  let niceFrac = 1024;
  for (let s = 0; s < steps.length; s++) {
    if (v <= steps[s]) { niceFrac = steps[s]; break; }
  }
  return niceFrac * Math.pow(1024, i);
}

/**
 * 30 分钟 @ 2 秒 = 900 个采样点,直接画会在几百像素里挤成一条噪声带。
 * 每 ~3px 取一个桶的均值:曲线读得出走势,真实的负载起伏跨多个桶仍然看得见。
 * timestamps 用同一个函数按同样的桶数降采样,才能和 cpu/memory 逐点对上——
 * 三个数组来自同一份原始快照,长度天生相等,桶的切法只取决于长度和目标点数。
 */
export function downsample(values, maxPoints) {
  if (values.length <= maxPoints) return values;
  const out = [];
  const bucket = values.length / maxPoints;
  for (let i = 0; i < maxPoints; i++) {
    const from = Math.floor(i * bucket);
    const to = Math.max(from + 1, Math.min(values.length, Math.floor((i + 1) * bucket)));
    let sum = 0;
    for (let j = from; j < to; j++) sum += values[j];
    out.push(sum / (to - from));
  }
  return out;
}

/** cpu/memory/gpu 都是 0-100% 的左轴;上传/下载共用右轴的同一段量纲(domain.max 由 niceMax() 决定)。 */
export function toY(value, domain, top, plotH) {
  const v = Math.max(domain.min, Math.min(domain.max, value));
  const range = domain.max - domain.min || 1;
  return top + (1 - (v - domain.min) / range) * plotH;
}

/** 悬浮提示/右侧轴标签里展示网络速率——和 src/util/sparkline.ts 的 formatRate 同一套算法。 */
export function formatRate(bytesPerSec) {
  if (!isFinite(bytesPerSec) || bytesPerSec < 0) return '0 B/s';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytesPerSec;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return value.toFixed(i === 0 ? 0 : 1) + ' ' + units[i] + '/s';
}

/** 图表对屏幕阅读器是一张图,alt 文本要把"最新值"这个唯一可读的信息说清楚。 */
export function describeChart(legend, windowLabel) {
  if (!legend || legend.length === 0) return windowLabel;
  const parts = legend.map(item => item.value ? item.name + ' ' + item.value : item.name);
  return windowLabel + ': ' + parts.join(', ');
}
