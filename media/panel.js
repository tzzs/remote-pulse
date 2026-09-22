import { niceMax, downsample, toY, formatRate as formatRateJs, describeChart } from './chart.js';

const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
let model = null;
let shapeKey = '';
let slots = [];
let chartEl = null;
let chartTitleEl = null;
let chartHint = null;
let chartTooltip = null;
/** cpu/memory/gpu/networkRx/networkTx 最多五条线各自的颜色/className——remotePulse.trendChartMetrics
    决定实际画哪几条,chartActiveDefs 按 key 而不是数组下标去这里查,顺序无关。上传/下载分成两条线
    (而不是 rx+tx 加在一起画一条),原因和状态栏网络项拆成 $(arrow-down)/$(arrow-up) 一样:合并了就分不清方向。 */
var SERIES_DEFS = [
  { key: 'cpu', colorVar: 'var(--rp-cpu)', className: 'cpu' },
  { key: 'memory', colorVar: 'var(--rp-mem)', className: 'mem' },
  { key: 'gpu', colorVar: 'var(--rp-gpu)', className: 'gpu' },
  { key: 'networkRx', colorVar: 'var(--rp-net-rx)', className: 'net-rx' },
  { key: 'networkTx', colorVar: 'var(--rp-net-tx)', className: 'net-tx' },
];
let chartActiveDefs = SERIES_DEFS.slice(0, 2);
/** 悬浮态跨轮询保留:每 2 秒的重绘会重建折线和圆点,如果不在重绘后把悬浮指示器按住原位置
    重新画一次,鼠标不动也会看到它每 2 秒闪一下。 */
let chartGuide = null;
let chartDots = [];
let hovering = false;
let lastPointerClientX = 0;
/** 当前这一屏折线对应的原始数据,悬浮时按屏幕 x 坐标反查最近的点。 */
let chartData = null;

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** 挂载点、GPU 型号、容器名都可能被 ellipsis 截断——同步写 title,悬浮才看得到全名。 */
function setText(node, text) {
  const value = text === undefined || text === null ? '' : String(text);
  if (node.textContent !== value) node.textContent = value;
  if (node.title !== value) node.title = value;
}

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key of Object.keys(attrs || {})) node.setAttribute(key, String(attrs[key]));
  return node;
}

// 之前这里画的是"圆圈 + 8 条从圆心向外的细直线",视觉上是个太阳/亮度图标而不是齿轮——
// 关键是齿的内缘要和外圈圆环有重叠(齿从半径 4.4 起,环带是 [2.8, 5.2]),两者才会连成
// 一个整体轮廓;之前齿的内缘在半径 5.2、环外缘只到 4.85,中间空了一圈缝,才会看着像太阳芒。
function gearIcon() {
  const node = svg('svg', { width: 15, height: 15, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  for (let i = 0; i < 8; i++) {
    node.appendChild(svg('rect', {
      x: 6.9, y: 1.2, width: 2.2, height: 2.4, rx: 0.5,
      fill: 'currentColor', transform: 'rotate(' + (i * 45) + ' 8 8)',
    }));
  }
  node.appendChild(svg('circle', { cx: 8, cy: 8, r: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4 }));
  node.appendChild(svg('circle', { cx: 8, cy: 8, r: 1.3, fill: 'none', stroke: 'currentColor', 'stroke-width': 0.9 }));
  return node;
}

/** 结构不变就只改文字和条宽,避免每 2 秒重建 DOM 打断用户的文字选中。 */
function shapeOf(m) {
  return JSON.stringify(m.groups.map(function (g) {
    if (g.kind === 'metrics') return ['m', g.title, g.rows.map(function (r) { return [r.label, !!r.sub, !!r.strong, r.percent !== undefined]; })];
    if (g.kind === 'table') return ['t', g.title, g.rows.map(function (r) { return r[0]; })];
    // 比较的是 legend 的 key 序列而不是长度——中途切换哪几条线(哪怕数量不变,比如把 cpu
    // 换成 gpu)也必须触发整块重建,否则 chartActiveDefs 和图例项对不上,apply() 会拿旧
    // slot 去读新模型,读错位置或者干脆把 GPU 数据画成 CPU 的颜色。
    return ['c', g.title, g.legend.map(function (item) { return item.key; }).join(',')];
  })) + '|' + m.host.name + '|' + m.host.meta + '|' + (m.host.user || '');
}

function build(m) {
  slots = [];
  chartEl = null;
  chartTitleEl = null;
  chartHint = null;
  chartTooltip = null;
  chartGuide = null;
  chartDots = [];
  chartData = null;
  hovering = false;
  const frag = document.createDocumentFragment();

  const host = el('div', 'host');
  const id = el('div', 'host-id');
  const icon = svg('svg', { class: 'host-icon', width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' });
  icon.appendChild(svg('rect', { x: 2.5, y: 2.5, width: 11, height: 4.5, rx: 1, stroke: 'currentColor', 'stroke-width': 1.1 }));
  icon.appendChild(svg('rect', { x: 2.5, y: 9, width: 11, height: 4.5, rx: 1, stroke: 'currentColor', 'stroke-width': 1.1 }));
  icon.appendChild(svg('circle', { cx: 5, cy: 4.75, r: 0.9, fill: 'currentColor' }));
  icon.appendChild(svg('circle', { cx: 5, cy: 11.25, r: 0.9, fill: 'currentColor' }));
  id.appendChild(icon);
  // 远程主机的身份就是 user@host——和 ssh 里看到的一致,用户名不另起一行。
  const title = m.host.user ? m.host.user + '@' + m.host.name : m.host.name;
  const nameNode = el('span', 'host-name', title);
  nameNode.title = title;
  id.appendChild(nameNode);
  if (m.host.meta) {
    const meta = el('span', 'host-meta');
    setText(meta, m.host.meta);
    id.appendChild(meta);
  }
  host.appendChild(id);
  const actions = el('div', 'host-actions');
  const updated = el('span', 'host-meta', m.updated);
  actions.appendChild(updated);
  slots.push({ kind: 'updated', node: updated });
  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'icon-btn';
  settingsBtn.title = m.settingsLabel;
  settingsBtn.setAttribute('aria-label', m.settingsLabel);
  settingsBtn.appendChild(gearIcon());
  // 文字和图标是同一个 <button>,不是拼在旁边的两个元素——光一个小齿轮图标不点点看猜不出
  // 是设置入口,但点击范围必须和图标绑在一起,不能出现"点文字没反应,只有图标能点"的割裂体验。
  settingsBtn.appendChild(el('span', '', m.settingsText));
  settingsBtn.addEventListener('click', function () { vscode.postMessage({ type: 'openSettings' }); });
  actions.appendChild(settingsBtn);
  host.appendChild(actions);
  frag.appendChild(host);

  for (const group of m.groups) {
    const section = el('div', 'section');
    // 屏幕阅读器靠 region + 名字才能在 System / Storage / GPU / Docker 之间跳转,
    // 否则整个面板读起来是一大片没有结构的文本。
    section.setAttribute('role', 'region');
    section.setAttribute('aria-label', group.title);
    const head = el('div', 'section-head');
    head.appendChild(el('span', 'section-title', group.title));

    if (group.kind === 'chart') {
      // 按 key 从 SERIES_DEFS 里找对应的颜色/className,而不是假设 legend 的第 i 项对应
      // SERIES_DEFS 的第 i 项——一旦某条线可以被单独勾掉,这个位置假设就不成立了。
      // 每次 build() 都拷贝一份新对象带上当前语言的 name,SERIES_DEFS 本身只提供 key/颜色这些不随语言变化的部分。
      chartActiveDefs = group.legend.map(function (item) {
        var def = SERIES_DEFS.filter(function (d) { return d.key === item.key; })[0];
        return { key: def.key, name: item.name, colorVar: def.colorVar, className: def.className };
      });
      const legend = el('span', 'legend');
      for (let i = 0; i < group.legend.length; i++) {
        const item = el('span', 'legend-item');
        const dot = el('span', 'swatch');
        dot.style.background = chartActiveDefs[i].colorVar;
        item.appendChild(dot);
        item.appendChild(document.createTextNode(group.legend[i].name));
        // 末端圆点旁边这个数才是真正的"当前值"——每轮采集都更新,不需要悬浮就看得到。
        const valueEl = el('span', 'legend-value', group.legend[i].value || '');
        item.appendChild(valueEl);
        legend.appendChild(item);
        slots.push({ kind: 'legend-value', node: valueEl });
      }
      head.appendChild(legend);
      section.appendChild(head);

      const chartWrap = el('div', 'chart-wrap');
      chartEl = svg('svg', { class: 'chart', preserveAspectRatio: 'none', role: 'img' });
      // <title> 是 SVG 的原生可访问名;aria-label 兜住不读 <title> 的实现。两者都在 apply() 里随数据更新。
      chartTitleEl = svg('title', {});
      chartEl.appendChild(chartTitleEl);
      chartEl.addEventListener('pointermove', onChartPointerMove);
      chartEl.addEventListener('pointerleave', onChartPointerLeave);
      chartWrap.appendChild(chartEl);
      chartTooltip = el('div', 'chart-tooltip');
      chartWrap.appendChild(chartTooltip);
      section.appendChild(chartWrap);

      chartHint = el('p', 'hint', group.emptyHint);
      chartHint.hidden = true;
      section.appendChild(chartHint);
      frag.appendChild(section);
      continue;
    }

    if (group.badge !== undefined) head.appendChild(el('span', 'badge', group.badge));
    section.appendChild(head);
    const rows = el('div', 'rows');

    if (group.kind === 'metrics') {
      for (const row of group.rows) {
        const hasBar = row.percent !== undefined;
        let className = 'row';
        if (row.sub) className += ' sub';
        if (row.strong) className += ' strong';
        if (!hasBar) className += ' wide';
        const node = el('div', className);
        const label = el('span', 'row-label');
        setText(label, row.label);
        node.appendChild(label);
        const detail = el('span', 'row-detail');
        setText(detail, row.detail);
        node.appendChild(detail);
        let fill = null;
        let track = null;
        if (hasBar) {
          track = el('span', 'track');
          // 纯视觉的进度条对屏幕阅读器等于不存在;补上 progressbar 语义后它会被读成
          // "CPU 进度条 23%",信息量和视力用户看到的一致。
          track.setAttribute('role', 'progressbar');
          track.setAttribute('aria-valuemin', '0');
          track.setAttribute('aria-valuemax', '100');
          track.setAttribute('aria-label', row.label);
          fill = el('span', 'fill');
          track.appendChild(fill);
          node.appendChild(track);
        }
        const value = el('span', 'row-value', row.value);
        node.appendChild(value);
        rows.appendChild(node);
        slots.push({ kind: 'row', node: node, detail: detail, value: value, fill: fill, track: track });
      }
    } else {
      const head2 = el('div', 'trow head');
      head2.appendChild(el('span', '', ''));
      head2.appendChild(el('span', '', group.columns[0]));
      head2.appendChild(el('span', '', group.columns[1]));
      rows.appendChild(head2);
      if (!group.rows.length && group.emptyHint) {
        rows.appendChild(el('p', 'hint', group.emptyHint));
      }
      for (const cells of group.rows) {
        const node = el('div', 'trow');
        const name = el('span', '');
        setText(name, cells[0]);
        const cpu = el('span', '', cells[1]);
        const mem = el('span', '', cells[2]);
        node.appendChild(name);
        node.appendChild(cpu);
        node.appendChild(mem);
        rows.appendChild(node);
        slots.push({ kind: 'cells', cpu: cpu, mem: mem });
      }
    }

    section.appendChild(rows);
    frag.appendChild(section);
  }

  root.replaceChildren(frag);
}

function apply(m) {
  let i = 0;
  slots[i++].node.textContent = m.updated;
  for (const group of m.groups) {
    if (group.kind === 'chart') {
      for (const item of group.legend) {
        const slot = slots[i++];
        slot.node.textContent = item.value || '';
      }
      // 图里唯一能用文字表达的就是"每条线现在是多少",随数据一起更新。
      if (chartEl && chartTitleEl) {
        const description = describeChart(group.legend, group.title);
        chartTitleEl.textContent = description;
        chartEl.setAttribute('aria-label', description);
      }
      continue;
    }
    if (group.kind === 'metrics') {
      for (const row of group.rows) {
        const slot = slots[i++];
        setText(slot.detail, row.detail);
        slot.value.textContent = row.value;
        slot.node.classList.toggle('warning', row.level === 'warning');
        slot.node.classList.toggle('critical', row.level === 'critical');
        if (slot.fill) {
        const pct = Math.max(0, Math.min(100, row.percent));
        slot.fill.style.width = pct + '%';
        slot.track.setAttribute('aria-valuenow', String(Math.round(pct)));
        slot.track.setAttribute('aria-valuetext', row.value);
      }
      }
    } else {
      for (const cells of group.rows) {
        const slot = slots[i++];
        slot.cpu.textContent = cells[1];
        slot.mem.textContent = cells[2];
      }
    }
  }
  drawChart(m.series);
}

function hideHover() {
  hovering = false;
  if (chartGuide) chartGuide.style.opacity = '0';
  for (const dot of chartDots) dot.style.opacity = '0';
  if (chartTooltip) chartTooltip.style.display = 'none';
}

/** CPU/内存/GPU 是 0-100 的百分比;上传/下载是原始 B/s,走右轴自己的量纲,不需要互相换算。 */
function formatSeriesValue(def, value) {
  if (def.key === 'networkRx' || def.key === 'networkTx') {
    return formatRateJs(Math.max(0, value));
  }
  return Math.round(Math.max(0, Math.min(100, value))) + '%';
}

function renderTooltipContent(valuesAtIndex, timeMs) {
  chartTooltip.replaceChildren();
  const d = new Date(timeMs);
  chartTooltip.appendChild(el('div', 'time', isNaN(d.getTime()) ? '' : d.toLocaleTimeString()));

  function metricRow(colorVar, name, text) {
    const row = el('div', 'metric');
    const dot = el('span', 'swatch');
    dot.style.background = colorVar;
    row.appendChild(dot);
    row.appendChild(el('span', '', name));
    row.appendChild(el('span', 'value', text));
    return row;
  }
  for (let i = 0; i < chartActiveDefs.length; i++) {
    const def = chartActiveDefs[i];
    chartTooltip.appendChild(metricRow(def.colorVar, def.name, formatSeriesValue(def, valuesAtIndex[i])));
  }
}

/**
 * clientX 是最近一次真实指针事件的横坐标;重绘后用同一坐标重算,悬浮态才能跨轮询保留。
 * 纵坐标不参与:悬浮提示按"离指针最近的采样点"定位,只取决于 x,浮层自己的 y 由那一列
 * 最高的那条线决定(见下面的 minY),和指针在竖直方向的位置无关。
 */
function updateHoverAt(clientX) {
  if (!chartData || chartData.xs.length === 0 || !chartEl || !chartGuide) {
    hideHover();
    return;
  }
  const rect = chartEl.getBoundingClientRect();
  if (rect.width <= 0) return;
  const viewBoxWidth = chartEl.viewBox && chartEl.viewBox.baseVal ? chartEl.viewBox.baseVal.width : rect.width;
  const scale = viewBoxWidth / rect.width;
  const xUnits = (clientX - rect.left) * scale;

  let nearest = 0;
  let bestDist = Infinity;
  for (let idx = 0; idx < chartData.xs.length; idx++) {
    const dist = Math.abs(chartData.xs[idx] - xUnits);
    if (dist < bestDist) { bestDist = dist; nearest = idx; }
  }

  const x = chartData.xs[nearest];
  const valuesAtIndex = chartData.series.map(function (s) { return s.vals[nearest]; });
  let minY = Infinity;
  for (let i = 0; i < chartData.series.length; i++) {
    const y = toY(valuesAtIndex[i], chartData.series[i].domain, chartData.top, chartData.plotH);
    const dot = chartDots[i];
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    dot.style.opacity = '1';
    if (y < minY) minY = y;
  }

  chartGuide.setAttribute('x1', x);
  chartGuide.setAttribute('x2', x);
  chartGuide.style.opacity = '1';

  renderTooltipContent(valuesAtIndex, chartData.times[nearest]);

  const wrap = chartEl.parentElement;
  const wrapRect = wrap.getBoundingClientRect();
  const offsetX = rect.left - wrapRect.left;
  const offsetY = rect.top - wrapRect.top;
  const pointLocalX = offsetX + x / scale;
  const pointLocalY = offsetY + minY / scale;

  chartTooltip.style.display = 'flex';
  const ttWidth = chartTooltip.offsetWidth;
  const ttHeight = chartTooltip.offsetHeight;
  let left = pointLocalX + 12;
  if (left + ttWidth > wrapRect.width) left = pointLocalX - ttWidth - 12;
  if (left < 0) left = 4;
  let top2 = pointLocalY - ttHeight - 10;
  if (top2 < 0) top2 = pointLocalY + 14;
  if (top2 + ttHeight > wrapRect.height) top2 = Math.max(0, wrapRect.height - ttHeight - 4);
  chartTooltip.style.left = left + 'px';
  chartTooltip.style.top = top2 + 'px';
}

function onChartPointerMove(event) {
  hovering = true;
  lastPointerClientX = event.clientX;
  updateHoverAt(event.clientX);
}

function onChartPointerLeave() {
  hideHover();
}

function valuesFor(key, series) {
  if (key === 'cpu') return series.cpu || [];
  if (key === 'memory') return series.memory || [];
  if (key === 'gpu') return series.gpu || [];
  if (key === 'networkRx') return series.networkRx || [];
  if (key === 'networkTx') return series.networkTx || [];
  return [];
}

function drawChart(series) {
  if (!chartEl) return;
  // 哪几条线在画由 chartActiveDefs(源自 trendChartMetrics)决定,不再假设 cpu/memory 一定存在。
  const hasData = chartActiveDefs.some(function (def) { return valuesFor(def.key, series).length > 1; });
  chartHint.hidden = hasData;
  chartEl.hidden = !hasData;
  if (!hasData) {
    chartData = null;
    hideHover();
    return;
  }

  const narrow = window.innerWidth < 520;
  const gutter = narrow ? 42 : 44;
  const plotH = narrow ? 112 : 132;
  const top = 8;
  const width = Math.max(160, Math.round(chartEl.getBoundingClientRect().width));
  const height = top + plotH + 10;
  chartEl.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  chartEl.setAttribute('width', String(width));
  chartEl.setAttribute('height', String(height));
  // replaceChildren 会连 <title> 一起清掉,重新挂回去,否则重绘一次可访问名就没了。
  chartEl.replaceChildren();
  if (chartTitleEl) chartEl.appendChild(chartTitleEl);

  // 上传/下载共用同一条独立的右侧 y 轴(自己的量纲,不是百分比)——右边多留出画刻度文字的空间;
  // 末端圆点的圆心如果落在视口边界上,半径里有一半会被裁掉,rightPad 同时兜住这个安全边距。
  const isNetworkKey = function (key) { return key === 'networkRx' || key === 'networkTx'; };
  const hasNetworkAxis = chartActiveDefs.some(function (def) { return isNetworkKey(def.key); });
  const endDotRadius = 2.5;
  // 最长的右轴标签("1023.9 KB/s"这类进位前的边界值)在 11px 字号下量出来约 66px 宽,
  // 78 留了安全余量——字号不随窄屏缩小,所以窄屏也不能比宽屏少留。
  const rightPad = hasNetworkAxis ? 78 : 5;
  const plotRight = width - rightPad;
  const span = plotRight - gutter;
  const maxPoints = Math.max(2, Math.floor(span / 3));
  const times = downsample(series.timestamps, maxPoints);
  const downsampled = chartActiveDefs.map(function (def) { return downsample(valuesFor(def.key, series), maxPoints); });
  const count = downsampled.length ? downsampled[0].length : 0;
  const xs = [];
  for (let i = 0; i < count; i++) xs.push(gutter + (span * i) / (count - 1));

  // cpu/memory/gpu 共用左轴的 0-100% 量纲;上传/下载没有天然上限,按这一屏两条线里较大的
  // 那个峰值一起取整成好看的刻度上限(niceMax)——必须用同一个 max,不然上传线和下载线各按
  // 各的峰值伸缩,同样的字节数在图上会画出不一样的高度,读者会看错谁比谁快。
  var networkPeak = 0;
  chartActiveDefs.forEach(function (def, i) {
    if (isNetworkKey(def.key) && downsampled[i].length) {
      networkPeak = Math.max(networkPeak, Math.max.apply(null, downsampled[i]));
    }
  });
  const networkDomain = { min: 0, max: niceMax(networkPeak) };
  const domains = chartActiveDefs.map(function (def) {
    if (isNetworkKey(def.key)) {
      return networkDomain;
    }
    return { min: 0, max: 100 };
  });

  for (let k = 0; k <= 4; k++) {
    const y = top + (plotH / 4) * k + 0.5;
    chartEl.appendChild(svg('line', { class: 'grid', x1: gutter, y1: y, x2: plotRight, y2: y, 'shape-rendering': 'crispEdges' }));
  }
  const leftMarks = [[top, '100%'], [top + plotH / 2, '50%'], [top + plotH, '0%']];
  for (const mark of leftMarks) {
    const label = svg('text', { class: 'axis', x: gutter - 8, y: mark[0], 'text-anchor': 'end', 'dominant-baseline': 'middle' });
    label.textContent = mark[1];
    chartEl.appendChild(label);
  }
  if (hasNetworkAxis) {
    const rightMarks = [[top, networkDomain.max], [top + plotH / 2, networkDomain.max / 2], [top + plotH, 0]];
    for (const mark of rightMarks) {
      const label = svg('text', { class: 'axis', x: plotRight + 8, y: mark[0], 'text-anchor': 'start', 'dominant-baseline': 'middle' });
      label.textContent = formatRateJs(mark[1]);
      chartEl.appendChild(label);
    }
  }

  function line(values, className, colorVar, domain) {
    if (values.length < 2) return;
    let points = '';
    for (let i = 0; i < values.length; i++) {
      const y = toY(values[i], domain, top, plotH);
      points += (i ? ' ' : '') + xs[i].toFixed(1) + ',' + y.toFixed(1);
    }
    chartEl.appendChild(svg('polyline', { class: className, points: points }));
    chartEl.appendChild(svg('circle', {
      cx: xs[xs.length - 1], cy: toY(values[values.length - 1], domain, top, plotH), r: endDotRadius, fill: colorVar,
    }));
  }
  // 按 legend 顺序(cpu, memory, gpu, 下载, 上传)倒序画:cpu 最受关注,压在最上层不被其他线盖住。
  for (let i = chartActiveDefs.length - 1; i >= 0; i--) {
    line(downsampled[i], chartActiveDefs[i].className, chartActiveDefs[i].colorVar, domains[i]);
  }

  // 悬浮的十字线和每条线各一个圆点:默认透明(见 CSS .guide/.hover-dot),指针移动时才显形。
  chartGuide = svg('line', { class: 'guide', x1: gutter, y1: top, x2: gutter, y2: top + plotH });
  chartEl.appendChild(chartGuide);
  chartDots = chartActiveDefs.map(function (def) {
    const dot = svg('circle', { class: 'hover-dot', r: 3, fill: def.colorVar });
    chartEl.appendChild(dot);
    return dot;
  });

  chartData = {
    xs: xs,
    series: chartActiveDefs.map(function (def, i) { return { key: def.key, vals: downsampled[i], domain: domains[i] }; }),
    times: times,
    top: top,
    plotH: plotH,
  };

  // 每轮采集都会重建以上这些元素:鼠标没动的话,在同一位置立刻把悬浮指示器画回去,
  // 否则用户停在某个点上看数值时,指示器会跟着 2 秒一次的刷新一起消失再出现。
  if (hovering) {
    updateHoverAt(lastPointerClientX);
  } else {
    hideHover();
  }
}

function render() {
  if (!model) return;
  const key = shapeOf(model);
  if (key !== shapeKey) {
    shapeKey = key;
    build(model);
  }
  apply(model);
}

window.addEventListener('message', function (event) {
  const message = event.data;
  if (message && message.type === 'model') {
    model = message.model;
    render();
  }
});
window.addEventListener('resize', function () { if (model) drawChart(model.series); });

vscode.postMessage({ type: 'ready' });
