/**
 * Render trace cells into a self-contained interactive HTML document.
 *
 * Visual design and interaction follow the reference trajectory page
 * (DeepSeek harness ui-trajectory):
 * - 32px toolbar (title, stats, Turns collapse toggle, search filter)
 * - a 40px timeline strip: three lanes (Input / Model / Tools), one span per
 *   record positioned by sequence with kind colors, turn boundary ticks
 * - a fixed two-column ledger (122px event column + content), 30px rows
 * - a right-hand details drawer (overview grid + monospace payload blocks)
 * Clicking a timeline span or a row selects it; hovering a span highlights
 * the row. Dark palette and type styles follow the reference theme. No
 * external dependencies — fully offline.
 */

import type { TraceCell, TraceDocument } from './trace-types';

const KIND_LABELS: Record<TraceCell['kind'], string> = {
  system: 'SYSTEM',
  user: 'USER',
  context: 'CONTEXT',
  compacted: 'COMPACTED',
  message: 'ASSISTANT',
  tool: 'TOOL',
};

// Dark-theme kind tag colors (text / background) and timeline span colors.
const KIND_TAG_STYLE: Record<TraceCell['kind'], string> = {
  system: 'color:#CFD3D6;background:#353638',
  user: 'color:#679EFE;background:#34415B',
  context: 'color:#59C984;background:#233C2C',
  compacted: 'color:#CFD3D6;background:#353638',
  message: 'color:#9474BC;background:#352F3A',
  tool: 'color:#DD8629;background:#27241F',
};

const SPAN_COLORS: Record<TraceCell['kind'], string> = {
  system: '#353638',
  user: '#679EFE',
  context: '#59C984',
  compacted: '#CFD3D6',
  message: '#8C6BB5',
  tool: '#DD8629',
};

// Timeline lane per kind (mirrors the reference: Input / Model / Tools).
const KIND_LANE: Record<TraceCell['kind'], number> = {
  user: 0,
  context: 1,
  message: 1,
  compacted: 1,
  tool: 2,
  system: 1,
};

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: #232324; color: #F9FAFB;
  font: 13px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
}
.mono { font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace; }
#root { display: flex; flex-direction: column; height: 100%; }
.toolbar {
  flex: 0 0 32px; display: flex; align-items: center; gap: 10px;
  padding: 0 6px; border-bottom: 1px solid rgba(255,255,255,.12);
  background: #232324;
}
.toolbar .title { font-size: 13px; font-weight: 500; color: #CFD3D6; padding-left: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.toolbar .count { font-size: 11px; color: #81858C; white-space: nowrap; }
.toolbar .btn {
  height: 22px; padding: 0 10px; border: 1px solid rgba(255,255,255,.12);
  border-radius: 4px; background: #2C2C2E; color: #CFD3D6; font-size: 12px; cursor: pointer;
  white-space: nowrap;
}
.toolbar .btn:hover { background: #353638; }
.toolbar .btn.on { border-color: #679EFE; color: #F9FAFB; background: #232324; }
.toolbar .search {
  margin-left: auto; display: flex; align-items: center;
  flex: 0 1 220px; min-width: 84px; height: 22px; padding: 0 8px;
  border: 1px solid rgba(255,255,255,.12); border-radius: 4px; background: #2C2C2E;
}
.toolbar .search:focus-within { border-color: #679EFE; background: #232324; }
.toolbar .search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: #F9FAFB; font-size: 12px; }
.toolbar .search input::placeholder { color: #81858C; }
.timeline {
  flex: 0 0 44px; position: relative; border-bottom: 1px solid rgba(255,255,255,.12);
  background: #1B1B1C; overflow: hidden; cursor: grab;
}
.timeline .lane-label { position: absolute; left: 4px; font-size: 10px; color: #81858C; line-height: 13px; }
.timeline .track { position: absolute; left: 74px; right: 8px; top: 4px; bottom: 4px; }
.locator {
  position: absolute; top: -4px; bottom: -4px; width: 2px; background: #679EFE;
  cursor: ew-resize; z-index: 6; pointer-events: auto; box-shadow: 0 0 6px rgba(103,158,254,.8);
}
.locator::after {
  content: ''; position: absolute; top: 0; left: -4px; width: 10px; height: 10px;
  background: #679EFE; border-radius: 2px;
}
.timeline .span {
  position: absolute; height: 9px; border-radius: 2px; min-width: 2px; cursor: pointer;
  border: 1px solid rgba(0,0,0,.25);
}
.timeline .span:hover { outline: 1px solid #F9FAFB; }
.timeline .span.active { outline: 2px solid #679EFE; }
.timeline .turnTick { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(255,255,255,.22); }
.tip {
  position: fixed; z-index: 30; pointer-events: none; max-width: 340px;
  background: #2C2C2E; border: 1px solid rgba(255,255,255,.2); border-radius: 6px;
  padding: 8px 10px; font-size: 12px; line-height: 17px; box-shadow: 0 4px 14px rgba(0,0,0,.5);
  display: none; white-space: normal; word-break: break-word;
}
.tip .tip-title { font-weight: 600; color: #F9FAFB; }
.tip .tip-facts { color: #ADB2B8; margin-top: 2px; }
.tip .tip-body { color: #CFD3D6; margin-top: 2px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.split { display: flex; flex: 1; min-height: 0; }
.tablePane { flex: 1; overflow-y: auto; overflow-x: hidden; }
table { width: 100%; border-spacing: 0; table-layout: fixed; }
col.event-column { width: 122px; }
td { height: 30px; padding: 0 8px; border-bottom: 1px solid rgba(255,255,255,.06); vertical-align: middle; }
td.event { padding-left: 10px; white-space: nowrap; }
td.content { padding-left: 4px; }
tr.row { cursor: pointer; }
tr.row { content-visibility: auto; contain-intrinsic-size: 30px; }
tr.row:hover { background: rgba(255,255,255,.08); }
tr.row.selected { background: rgba(255,255,255,.14); }
tr.row.selected td { box-shadow: inset 1px 0 0 #679EFE; }
tr.turnrow td { background: #1B1B1C; font-weight: 500; }
.kindTag {
  display: inline-flex; align-items: center; height: 19px; padding: 0 5px;
  border-radius: 4px; font-size: 10px; font-weight: 650; line-height: 16px;
  letter-spacing: .035em; max-width: 96px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.seq { margin-left: 6px; font-size: 11px; color: #81858C; }
.summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: #F9FAFB; }
.toolline { font-family: "SF Mono", "JetBrains Mono", Consolas, Menlo, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toolline .tname { color: #F9FAFB; }
.toolline .targs { margin-left: 7px; color: #ADB2B8; }
.toolline .tarrow { margin-left: 7px; color: #81858C; }
.toolline .tresult { margin-left: 7px; color: #CFD3D6; }
.toolline .terror { margin-left: 7px; color: #F25A5A; }
.toolline .tempty { margin-left: 7px; color: #81858C; }
.facts { color: #81858C; font-size: 11px; margin-left: 8px; display: inline; }
.detail {
  width: clamp(320px, 38%, 440px); max-width: calc(100% - 280px);
  border-left: 1px solid rgba(255,255,255,.12); background: #232324;
  display: flex; flex-direction: column; min-height: 0;
}
.detail.hidden { display: none; }
.detail .dhead {
  flex: 0 0 42px; display: flex; align-items: center; gap: 8px;
  padding: 0 8px 0 12px; border-bottom: 1px solid rgba(255,255,255,.12);
}
.detail .dhead .dname { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail .dhead .dclose { margin-left: auto; width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: #ADB2B8; font-size: 18px; cursor: pointer; }
.detail .dhead .dclose:hover { background: rgba(255,255,255,.08); }
.detail .dbody { flex: 1; overflow-y: auto; padding: 12px 14px; }
.ovgrid { display: grid; grid-template-columns: 94px minmax(0, 1fr); gap: 2px 12px; font-size: 13px; }
.ovgrid dt { color: #ADB2B8; }
.ovgrid dd { margin: 0; color: #F9FAFB; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.section { margin-top: 16px; }
.section h4 { margin: 0 0 4px; font-size: 11px; font-weight: 500; color: #CFD3D6; text-transform: uppercase; }
.payload {
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
  font-size: 12px; line-height: 19px; background: #1B1B1C; padding: 14px;
  border-radius: 4px; white-space: pre-wrap; word-break: break-word; color: #CFD3D6;
}
.payload.error { color: #F25A5A; }
.placeholder { color: #81858C; padding: 32px; text-align: center; }
`;

const RENDER_JS = `
var cells = JSON.parse(document.getElementById('data').textContent);
var labels = ${JSON.stringify(KIND_LABELS)};
var tagStyles = ${JSON.stringify(KIND_TAG_STYLE)};
var spanColors = ${JSON.stringify(SPAN_COLORS)};
var laneOf = ${JSON.stringify(KIND_LANE)};
var tbody = document.getElementById('rows');
var drawer = document.getElementById('detail');
var drawerName = document.getElementById('dname');
var drawerBody = document.getElementById('dbody');
var searchInput = document.getElementById('q');
var timeline = document.getElementById('timeline-track');
var track = timeline;
var tablePane = document.querySelector('.tablePane');
var locator = document.getElementById('locator');
var currentFiltered = [];
var turnsBtn = document.getElementById('turns');
var callsBtn = document.getElementById('calls');
var modeBtn = document.getElementById('mode');
var jsonBtn = document.getElementById('json');
var tip = document.getElementById('tip');
var collapsedTurns = false;
var collapsedCalls = false;
var timeMode = false;
var selectedIndex = -1;
var rowEls = [];
function showTip(text, x, y) {
  tip.innerHTML = text;
  tip.style.display = 'block';
  var w = tip.offsetWidth, h = tip.offsetHeight;
  var left = x + 14, top = y + 14;
  if (left + w > window.innerWidth - 8) left = x - w - 14;
  if (top + h > window.innerHeight - 8) top = y - h - 14;
  tip.style.left = Math.max(4, left) + 'px';
  tip.style.top = Math.max(4, top) + 'px';
}
function hideTip() { tip.style.display = 'none'; }
function fmtMs(v) { if (v === undefined || v === null) return null; if (v < 1000) return v + ' ms'; return (v / 1000).toFixed(2) + ' s'; }
function timingFacts(cell) {
  var parts = [];
  var ttft = fmtMs(cell.ttftMs), dec = fmtMs(cell.decodingMs);
  if (ttft) parts.push('TTFT ' + ttft);
  if (dec) parts.push('解码 ' + dec);
  if (cell.model) parts.push('模型 ' + cell.model);
  if (cell.finishReason) parts.push('结束 ' + cell.finishReason);
  return parts;
}
function esc(v) { return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtSeconds(s) {
  if (s === null || s === undefined) return '—';
  if (s < 1) return Math.round(s * 1000) + ' ms';
  return s.toFixed(2) + ' s';
}
function toolContent(cell) {
  var html = '<span class="tname">' + esc(cell.text) + '</span>';
  if (cell.inputDetail) html += '<span class="targs">' + esc(cell.inputDetail) + '</span>';
  if (cell.isError) html += '<span class="terror">→ ' + esc(cell.result || 'failed') + '</span>';
  else if (cell.result) html += '<span class="tarrow">→</span><span class="tresult">' + esc(cell.result) + '</span>';
  else html += '<span class="tempty">→ No output</span>';
  return html;
}
function overviewRows(cell) {
  var rows = [['类型', labels[cell.kind] || cell.kind], ['序号', '#' + cell.index], ['耗时', fmtSeconds(cell.timeSeconds)]];
  if (cell.turn) rows.push(['回合', String(cell.turn)]);
  if (cell.input !== undefined) rows.push(['输入', String(cell.input)]);
  if (cell.cacheRead) rows.push(['缓存读', String(cell.cacheRead)]);
  if (cell.cacheWrite) rows.push(['缓存写', String(cell.cacheWrite)]);
  if (cell.output !== undefined) rows.push(['输出', String(cell.output)]);
  var ttft = fmtMs(cell.ttftMs);
  if (ttft) rows.push(['TTFT', ttft]);
  var dec = fmtMs(cell.decodingMs);
  if (dec) rows.push(['解码', dec]);
  if (cell.model) rows.push(['模型', cell.model]);
  if (cell.finishReason) rows.push(['结束', cell.finishReason]);
  return rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('');
}
function section(title, value, cls) {
  if (!value) return '';
  return '<div class="section"><h4>' + title + '</h4><div class="payload' + (cls ? ' ' + cls : '') + '">' + esc(value) + '</div></div>';
}
function showDetail(i) {
  if (selectedIndex === i) { hideDetail(); return; }
  selectedIndex = i;
  var cell = cells[i];
  for (var k = 0; k < rowEls.length; k++) rowEls[k].classList.remove('selected');
  if (rowEls[i]) {
    rowEls[i].classList.add('selected');
    if (rowEls[i].scrollIntoView) rowEls[i].scrollIntoView({ block: 'center' });
  }
  var spans = timeline.querySelectorAll('.span');
  for (var s = 0; s < spans.length; s++) spans[s].classList.remove('active');
  if (timeline.querySelector('span[data-i="' + i + '"]')) timeline.querySelector('span[data-i="' + i + '"]').classList.add('active');
  drawerName.textContent = (labels[cell.kind] || cell.kind) + ' #' + cell.index;
  var html = '<dl class="ovgrid">' + overviewRows(cell) + '</dl>';
  html += section('思考', cell.thinkingDetail);
  html += section('内容', cell.outputDetail);
  html += section('输入', cell.inputDetail);
  if (cell.kind === 'tool') html += section('工具结果', cell.result || cell.outputDetail, cell.isError ? 'error' : '');
  drawerBody.innerHTML = html || '<div class="placeholder">无详情</div>';
  drawer.classList.remove('hidden');
}
function hideDetail() {
  selectedIndex = -1;
  drawer.classList.add('hidden');
  for (var k = 0; k < rowEls.length; k++) rowEls[k].classList.remove('selected');
  var spans = timeline.querySelectorAll('.span');
  for (var s = 0; s < spans.length; s++) spans[s].classList.remove('active');
}
function renderTimeline(visible) {
  timeline.innerHTML = '';
  if (visible.length < 2) return;
  var n = visible.length;
  if (timeMode && visible.every(function (c) { return c.startedAt !== undefined; })) {
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < n; i++) {
      var s = visible[i].startedAt, e = visible[i].endAt !== undefined ? visible[i].endAt : (s || 0) + 1000;
      if (s < min) min = s;
      if (e > max) max = e;
    }
    var total = max - min;
    var idleCap = total * 0.05; // compress idle gaps longer than 5% of the span
    var cursor = min;
    var scaled = [];
    for (var j = 0; j < n; j++) {
      var cs = visible[j].startedAt;
      var ce = visible[j].endAt !== undefined ? visible[j].endAt : cs + 1000;
      var gap = cs - cursor;
      if (gap > idleCap) { min += gap - idleCap; max -= gap - idleCap; }
      cursor = ce;
      scaled.push([cs - min, ce - min]);
    }
    total = max - min;
    for (var k = 0; k < n; k++) {
      var span = makeSpan(visible[k], k, (scaled[k][0] / total) * 100, (scaled[k][1] - scaled[k][0]) / total * 100);
      timeline.appendChild(span);
    }
  } else {
    var widthPct = 100 / n;
    for (var m = 0; m < n; m++) {
      var sp = makeSpan(visible[m], m, m * widthPct, widthPct - 0.4);
      timeline.appendChild(sp);
    }
  }
  // Turn boundary ticks (time mode uses the scaled coordinates).
  var prevTurn = null;
  for (var t = 0; t < n; t++) {
    var tn = visible[t].turn || 0;
    if (prevTurn !== null && tn !== prevTurn) {
      var tick = document.createElement('span');
      tick.className = 'turnTick';
      if (timeMode && scaled) {
        tick.style.left = (scaled[t][0] / total * 100) + '%';
      } else {
        tick.style.left = (t * 100 / n) + '%';
      }
      timeline.appendChild(tick);
    }
    prevTurn = tn;
  }
}
function makeSpan(cell, idx, leftPct, widthPct) {
  var span = document.createElement('span');
  span.className = 'span';
  span.style.left = Math.max(0, leftPct) + '%';
  span.style.width = 'max(2px, ' + Math.max(0.3, widthPct) + '%)';
  span.style.top = (laneOf[cell.kind] || 1) * 13 + 'px';
  span.style.background = spanColors[cell.kind] || '#353638';
  span.setAttribute('data-i', String(idx));
  span.title = '';
  span.addEventListener('mouseenter', function (e) {
    if (rowEls[idx]) rowEls[idx].classList.add('hover');
    if (cells.length <= 2000) {
      var facts = timingFacts(cell);
      var ftext = [];
      if (cell.timeSeconds !== null && cell.timeSeconds !== undefined) ftext.push('耗时 ' + cell.timeSeconds.toFixed(1) + 's');
      ftext = ftext.concat(facts);
      showTip('<div class="tip-title">#' + cell.index + ' ' + (labels[cell.kind] || cell.kind) + '</div>' +
        (ftext.length ? '<div class="tip-facts">' + ftext.join(' · ') + '</div>' : '') +
        '<div class="tip-body">' + esc(cell.text) + '</div>', e.clientX, e.clientY);
    }
  });
  span.addEventListener('mousemove', function (e) { if (cells.length <= 2000) { tip.style.left = '0px'; tip.style.top = '0px'; showTip(tip.innerHTML, e.clientX, e.clientY); } });
  span.addEventListener('mouseleave', function () { if (rowEls[idx]) rowEls[idx].classList.remove('hover'); hideTip(); });
  span.addEventListener('click', function (e) {
    e.stopPropagation();
    showDetail(idx);
  });
  return span;
}
function render() {
  var q = (searchInput.value || '').toLowerCase();
  // Keep every cell (including requestOnly system rows) so ledger indices
  // stay aligned with the cells array; the timeline renders them too.
  currentFiltered = cells.filter(function (c) {
    if (collapsedCalls && c.kind === 'tool') return false;
    if (q && !(c.text + ' ' + (c.outputDetail || '') + ' ' + (c.thinkingDetail || '')).toLowerCase().includes(q)) return false;
    return true;
  });
  var filtered = currentFiltered;
  renderTimeline(filtered);
  tbody.innerHTML = '';
  rowEls = [];
  var shown = 0;
  var lastTurn = null;
  var turnCounts = {};
  for (var i = 0; i < filtered.length; i++) turnCounts[filtered[i].turn || 0] = (turnCounts[filtered[i].turn || 0] || 0) + 1;
  for (var i2 = 0; i2 < filtered.length; i2++) {
    var cell = filtered[i2];
    var turn = cell.turn || 0;
    var row;
    if (collapsedTurns) {
      // Collapsed mode: one summary row per turn; cell rows are skipped.
      if (turn !== lastTurn) {
        var trow = document.createElement('tr');
        trow.className = 'row turnrow';
        var tev = document.createElement('td');
        tev.className = 'event';
        tev.innerHTML = '<span class="kindTag" style="' + tagStyles.user + '">TURN</span><span class="seq">' + turn + '</span>';
        var tco = document.createElement('td');
        tco.className = 'content';
        var tsum = document.createElement('div');
        tsum.className = 'summary';
        tsum.textContent = cell.text;
        tco.appendChild(tsum);
        var tfacts = document.createElement('span');
        tfacts.className = 'facts';
        tfacts.textContent = '· ' + (turnCounts[turn] || 0) + ' 条';
        tco.appendChild(tfacts);
        trow.appendChild(tev); trow.appendChild(tco);
        trow.addEventListener('click', (function (t) {
          return function () {
            collapsedTurns = false;
            if (turnsBtn) turnsBtn.classList.remove('on');
            render();
            var idx = currentFiltered.findIndex(function (c) { return c.turn === t; });
            if (idx >= 0 && rowEls[idx]) { rowEls[idx].scrollIntoView({ block: 'center' }); showDetail(idx); }
          };
        })(turn));
        tbody.appendChild(trow);
        shown++;
        lastTurn = turn;
      }
      continue;
    }
    row = document.createElement('tr');
    row.className = 'row';
    if (selectedIndex === i2) row.classList.add('selected');
    var tag = document.createElement('span');
    tag.className = 'kindTag';
    tag.setAttribute('style', tagStyles[cell.kind]);
    tag.textContent = labels[cell.kind] || cell.kind;
    var seq = document.createElement('span');
    seq.className = 'seq';
    seq.textContent = '#' + cell.index;
    var eventTd = document.createElement('td');
    eventTd.className = 'event';
    eventTd.appendChild(tag); eventTd.appendChild(seq);
    var contentTd = document.createElement('td');
    contentTd.className = 'content';
    if (cell.kind === 'tool') {
      var tl = document.createElement('div');
      tl.className = 'toolline';
      tl.innerHTML = toolContent(cell);
      contentTd.appendChild(tl);
    } else {
      var sum = document.createElement('div');
      sum.className = 'summary';
      sum.textContent = cell.text;
      contentTd.appendChild(sum);
      var facts = document.createElement('span');
      facts.className = 'facts';
      var f = [];
      if (cell.timeSeconds !== null && cell.timeSeconds !== undefined) f.push(fmtSeconds(cell.timeSeconds));
      f = f.concat(timingFacts(cell));
      if (cell.input !== undefined) f.push('in ' + cell.input);
      if (cell.cacheRead) f.push('read ' + cell.cacheRead);
      if (cell.cacheWrite) f.push('write ' + cell.cacheWrite);
      if (cell.output !== undefined) f.push('out ' + cell.output);
      if (f.length) facts.textContent = '· ' + f.join(' · ');
      contentTd.appendChild(facts);
    }
    row.appendChild(eventTd); row.appendChild(contentTd);
    (function (idx, el) { el.addEventListener('click', function () { showDetail(idx); }); })(i2, row);
    tbody.appendChild(row);
    rowEls[i2] = row;
    shown++;
    lastTurn = turn;
  }
  if (!shown) tbody.innerHTML = '<tr><td colspan="2"><div class="placeholder">无匹配记录</div></td></tr>';
  document.getElementById('count').textContent = shown + ' 条';
}
if (searchInput) searchInput.addEventListener('input', render);
if (turnsBtn) turnsBtn.addEventListener('click', function () { collapsedTurns = !collapsedTurns; turnsBtn.classList.toggle('on', collapsedTurns); render(); });
if (callsBtn) callsBtn.addEventListener('click', function () { collapsedCalls = !collapsedCalls; callsBtn.classList.toggle('on', collapsedCalls); render(); });
if (modeBtn) modeBtn.addEventListener('click', function () { timeMode = !timeMode; modeBtn.textContent = timeMode ? 'Time' : 'Seq'; modeBtn.classList.toggle('on', timeMode); render(); });
if (jsonBtn) jsonBtn.addEventListener('click', function () {
  var blob = new Blob([JSON.stringify({ cells: cells }, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'scream-trace.json';
  a.click();
  URL.revokeObjectURL(url);
});
// Timeline navigation: wheel or drag over the strip scrolls the ledger and
// positions the view at the corresponding rows.
var timelineEl = timeline.parentElement;
timelineEl.addEventListener('wheel', function (e) {
  if (!tablePane) return;
  e.preventDefault();
  tablePane.scrollTop += e.deltaY * 3;
}, { passive: false });
var dragStartY = null, dragStartScroll = 0;
timelineEl.addEventListener('mousedown', function (e) {
  dragStartY = e.clientY;
  dragStartScroll = tablePane ? tablePane.scrollTop : 0;
});
window.addEventListener('mousemove', function (e) {
  if (dragStartY === null || !tablePane) return;
  tablePane.scrollTop = dragStartScroll + (dragStartY - e.clientY) * 3;
});
window.addEventListener('mouseup', function () { dragStartY = null; });
// Draggable locator: drag or click on the strip to jump to a row.
var locDrag = false;
function locateAt(clientX) {
  var trackRect = track.getBoundingClientRect();
  var p = Math.min(1, Math.max(0, (clientX - trackRect.left) / trackRect.width));
  // The locator lives in .timeline (outside the cleared track); offset by the track origin.
  locator.style.left = (trackRect.left - timelineRectLeft() + p * trackRect.width - 1) + 'px';
  var n = currentFiltered.length;
  if (n < 2) return;
  var idx = Math.round(p * (n - 1));
  if (rowEls[idx] && rowEls[idx].scrollIntoView) rowEls[idx].scrollIntoView({ block: 'center' });
}
function timelineRectLeft() {
  return timeline.parentElement.getBoundingClientRect().left;
}
locator.addEventListener('mousedown', function (e) { e.stopPropagation(); e.preventDefault(); locDrag = true; });
window.addEventListener('mousemove', function (e) {
  if (!locDrag) return;
  locateAt(e.clientX);
});
window.addEventListener('mouseup', function () { locDrag = false; });
timelineEl.addEventListener('click', function (e) {
  if (e.target === locator) return;
  locateAt(e.clientX);
});
function syncLocatorFromTable() {
  if (!tablePane) return;
  var max = tablePane.scrollHeight - tablePane.clientHeight;
  var p = max > 0 ? tablePane.scrollTop / max : 0;
  var trackRect = track.getBoundingClientRect();
  locator.style.left = (trackRect.left - timelineRectLeft() + p * trackRect.width - 1) + 'px';
}
if (tablePane) tablePane.addEventListener('scroll', syncLocatorFromTable);
render();
syncLocatorFromTable();
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderTraceHtml(doc: TraceDocument): string {
  const dataJson = JSON.stringify(doc.cells).replaceAll('</', '<\\/');
  const meta = `${escapeHtml(doc.sessionId)} · ${new Date(doc.createdAt).toLocaleString()}`;

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.title)} — 会话轨迹</title>
<style>${CSS}</style>
</head>
<body>
<div id="root">
  <div class="toolbar">
    <span class="title">${escapeHtml(doc.title)}</span>
    <span class="count" id="count"></span>
    <span class="count">${meta}</span>
    <button class="btn" id="turns">Turns</button>
    <button class="btn" id="calls">Calls</button>
    <button class="btn" id="mode">Seq</button>
    <button class="btn" id="json">JSON</button>
    <div class="search"><input id="q" type="search" placeholder="搜索…"></div>
  </div>
    <div class="timeline">
    <span class="lane-label" style="top:2px">Input</span>
    <span class="lane-label" style="top:16px">Model</span>
    <span class="lane-label" style="top:30px">Tools</span>
    <div class="track" id="timeline-track"></div>
    <div class="locator" id="locator"></div>
    </div>
  <div class="split">
    <div class="tablePane">
      <table>
        <colgroup><col class="event-column"><col></colgroup>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <aside class="detail hidden" id="detail">
      <div class="dhead"><span class="dname mono" id="dname"></span>
        <button class="dclose" onclick="hideDetail()">×</button></div>
      <div class="dbody" id="dbody"></div>
    </aside>
  </div>
</div>
<script id="data" type="application/json">${dataJson}</script>
<script>${RENDER_JS}</script>
<div class="tip" id="tip"></div>
</body>
</html>`;
}
