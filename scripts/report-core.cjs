/* 업무 보고서(일일 · 주간 · 월간) 생성 공통 로직 — 포털(브라우저)과 GitHub Actions(Node)에서 똑같이 사용
   입력: 포털 데이터(app_state.data) + 노션 이전 지연·정비 기록(window.__YUM_NOTION_FINAL__) + 일지 양식(templates)
   출력: { kind, key, title, summary(알림용 한 줄), stats, html(메일·포털 표시용 — 메일에서도 깨지지 않는 표 기반 그래프), text(AI 요약용) }
   일지 내용 읽기: 양식의 칸 제목(열 머리 · 줄 이름)을 읽어 값의 뜻을 알아냄
     · 기준 범위(예: 135 ~ 150 ℃, 125℃이상, 200 ± 20, (70-80℃))가 적힌 줄 · 열의 값 → 기준 벗어남 자동 감지
     · 판정 O/X · 적합/부적합 → 부적합 감지
     · 특이사항 · 개선조치 · 정지 사유 · 비고 → 현장 메모
     · 근무일보 OT · 인원, 멸균 업무일지 가동시간 · 적산량 · 배치 · 정지 기록                                       */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.YumReportCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var DIVS = ['가공2팀', '가공1팀', '포장팀'];
  var DIVSUB = { '가공2팀': '배합 · 착즙', '가공1팀': '멸균', '포장팀': '포장' };
  var TEAMS = ['배합팀', '착즙팀', '멸균팀', '포장팀', '공통'];
  var DOW = '일월화수목금토';
  var C = { navy: '#13254B', navy2: '#24448C', gold: '#C8A15A', gold2: '#E3C68B', ink: '#111A2E', mute: '#5A6680', line: '#E6E9F1', soft: '#F5F7FB',
    red: '#D64545', redBg: '#FDECEC', amber: '#E0902F', amberBg: '#FFF4E3', green: '#2E9E6A', greenBg: '#E7F6EE', blue: '#2F6FD6', teal: '#12A3A0' };
  var DC = { '가공2팀': '#2F6FD6', '가공1팀': '#12A3A0', '포장팀': '#E0902F' };
  var TC = { '배합팀': '#7B5CD6', '착즙팀': '#2F6FD6', '멸균팀': '#12A3A0', '포장팀': '#E0902F', '공통': '#8A94A8' };
  var FONT = "'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif";

  /* ───────── 날짜 ───────── */
  function kstDate(offsetDays, now) {
    var t = (now ? new Date(now) : new Date()).getTime() + 9 * 3600 * 1000 + (offsetDays || 0) * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  }
  function addDays(d, n) { var t = new Date(d + 'T00:00:00Z').getTime() + n * 86400000; return new Date(t).toISOString().slice(0, 10); }
  function dowN(d) { return new Date(d + 'T00:00:00Z').getUTCDay(); }
  function dowOf(d) { return DOW[dowN(d)]; }
  function md(d) { return (+d.slice(5, 7)) + '/' + (+d.slice(8, 10)); }
  function range(a, b) { var o = []; for (var d = a; d <= b; d = addDays(d, 1)) o.push(d); return o; }
  function monthEnd(ym) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
  function prevMonth(ym) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1; if (m < 1) { m = 12; y--; } return y + '-' + (m < 10 ? '0' : '') + m; }
  function weekStart(d) { var w = dowN(d); return addDays(d, w === 0 ? -6 : 1 - w); }   // 월요일
  function isoWeek(d) {
    var t = new Date(d + 'T00:00:00Z'), day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3);
    var y = t.getUTCFullYear(), f = new Date(Date.UTC(y, 0, 4)), fd = (f.getUTCDay() + 6) % 7; f.setUTCDate(f.getUTCDate() - fd + 3);
    return y + '-W' + ('0' + (1 + Math.round((t - f) / 604800000))).slice(-2);
  }
  /* kind: daily | weekly | monthly, ref: 기준일(보통 보내는 날) → 보고 기간 */
  function period(kind, ref, now) {
    ref = ref || kstDate(0, now);
    if (kind === 'weekly') {
      var a = addDays(weekStart(ref), -7), b = addDays(a, 6);
      return { kind: kind, key: isoWeek(a), from: a, to: b, pFrom: addDays(a, -7), pTo: addDays(a, -1), label: md(a) + ' ~ ' + md(b) + ' (' + isoWeek(a).replace('-W', '년 ') + '주차)' };
    }
    if (kind === 'monthly') {
      var ym = prevMonth(ref.slice(0, 7)), f = ym + '-01', t = monthEnd(ym), py = prevMonth(ym);
      return { kind: kind, key: ym, from: f, to: t, pFrom: py + '-01', pTo: monthEnd(py), label: (+ym.slice(0, 4)) + '년 ' + (+ym.slice(5, 7)) + '월' };
    }
    var D = ref; // daily: ref = 보고 대상일
    return { kind: 'daily', key: D, from: D, to: D, pFrom: addDays(D, -7), pTo: addDays(D, -1), label: D + ' (' + dowOf(D) + ')' };
  }

  /* ───────── 공통 도구 ───────── */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function mdLite(t) { return esc(String(t || '').trim()).replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/^\s*[-*•]\s+/gm, '• ').replace(/\n/g, '<br>'); }
  function hrs(m) { m = Math.round(+m || 0); if (m < 60) return m + '분'; var h = Math.floor(m / 60), r = m % 60; return h + '시간' + (r ? ' ' + r + '분' : ''); }
  function hshort(m) { m = +m || 0; return m >= 60 ? (Math.round(m / 6) / 10) + 'h' : Math.round(m) + 'm'; }
  function toMin(t) { if (!t) return null; var p = String(t).split(':'); if (p.length < 2) return null; return (+p[0]) * 60 + (+p[1]); }
  function rmins(s, e) { var a = toMin(s), b = toMin(e); if (a == null || b == null) return null; if (b < a) b += 1440; return b - a; }
  function num(v) { if (v == null) return null; var s = String(v).replace(/,/g, '').trim(); var m = s.match(/^-?\d+(\.\d+)?/); return m ? +m[0] : null; }
  function hoursOf(v) { /* 2 · 1.5 · 2:30 · 2시간 30분 → 시간 */
    if (v == null || v === '') return 0; var s = String(v).trim(); var m = s.match(/^(\d+):(\d{1,2})$/); if (m) return +m[1] + (+m[2]) / 60;
    m = s.match(/(\d+(?:\.\d+)?)\s*시간(?:\s*(\d+)\s*분)?/); if (m) return +m[1] + (m[2] ? +m[2] / 60 : 0);
    m = s.match(/^(\d+)\s*분$/); if (m) return +m[1] / 60; var n = num(s); return n == null ? 0 : n;
  }
  function sum(a, f) { return a.reduce(function (s, x) { return s + (f ? (+f(x) || 0) : (+x || 0)); }, 0); }
  function topBy(list, keyf, valf, n) {
    var g = {};
    list.forEach(function (r) { var k = keyf(r); if (!k) return; g[k] = g[k] || [0, 0]; g[k][0] += valf ? (+valf(r) || 0) : 1; g[k][1]++; });
    return Object.keys(g).map(function (k) { return [k, g[k][0], g[k][1]]; }).sort(function (a, b) { return b[1] - a[1] || b[2] - a[2]; }).slice(0, n || 5);
  }
  function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }
  function delta(cur, prev) { if (!prev) return cur ? null : 0; return Math.round((cur - prev) / prev * 100); }
  function clip(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  /* ───────── 지연 · 정비 기록 (노션 이전 + 포털 작성) ───────── */
  function records(data, NF) {
    NF = NF || { delay: [], maint: [] };
    var out = [];
    (NF.delay || []).forEach(function (r) { out.push({ div: r[1] === '멸균팀' ? '가공1팀' : '가공2팀', kind: 'delay', src: 'notion', d: r[0], team: r[1], hogi: r[2], product: r[3], reason: r[4], start: r[5], end: r[6], min: r[7], detail: r[8] }); });
    (NF.delay1 || []).forEach(function (r) { out.push({ div: '가공1팀', kind: 'delay', src: 'notion', d: r[0], team: r[1], hogi: r[2], product: r[3], reason: r[4], start: r[5], end: r[6], min: r[7], detail: r[8] }); });
    (NF.maint || []).forEach(function (r) { out.push({ div: '가공2팀', kind: 'maint', src: 'notion', d: r[0], asset: r[1], content: r[2], mtype: r[3], person: r[4], etc: r[5] }); });
    ((data && data.opLogs) || []).forEach(function (o) {
      if (!o || !o.d || o.deleted) return;
      if (o.kind === 'delay') out.push({ div: o.div || '가공2팀', kind: 'delay', src: 'web', d: o.d, team: o.team || '', hogi: o.hogi || '', product: o.product || '', reason: o.reason || '', start: o.start || '', end: o.end || '', min: (o.totalMin !== '' && o.totalMin != null) ? +o.totalMin : rmins(o.start, o.end), detail: o.detail || '' });
      else out.push({ div: o.div || '가공2팀', kind: 'maint', src: 'web', d: o.d, asset: o.asset || '', content: o.content || '', mtype: o.mtype || '', person: o.person || '', etc: o.etc || '' });
    });
    return out;
  }

  /* ───────── 일지 양식 읽기: 입력칸마다 줄 이름 · 열 머리 · 기준 범위 ───────── */
  var FCACHE = {};
  function cellText(c) {
    if (c.x != null) return String(c.x).replace(/[\/∕]/g, ' ').replace(/\s+/g, ' ').trim();
    if (c.tpl && !/\{(in|tm|sel):/.test(c.tpl)) return String(c.tpl).replace(/\{[^}]*\}/g, ' ').replace(/[\/∕]/g, ' ').replace(/\s+/g, ' ').trim();
    return '';
  }
  function introspect(code, wt) {
    if (!wt || !wt.blocks) return [];
    var ck = code + ':' + (wt.ver || (wt.blocks.length + '/' + JSON.stringify(wt.blocks[0] || {}).length));
    if (FCACHE[ck]) return FCACHE[ck];
    var out = [];
    var prevTs = [];
    wt.blocks.forEach(function (b, bi) {
      if (b.t !== 'tbl' || !b.rows) return;
      var occ = [], cells = [];
      b.rows.forEach(function (row, ri) {
        occ[ri] = occ[ri] || [];
        var c0 = 0;
        (row || []).forEach(function (c) {
          while (occ[ri][c0]) c0++;
          var s = c.s || 1, rs = c.rs || 1;
          var info = { c: c, r0: ri, c0: c0, s: s, rs: rs, text: cellText(c) };
          for (var a = 0; a < rs; a++) { occ[ri + a] = occ[ri + a] || []; for (var q = 0; q < s; q++) occ[ri + a][c0 + q] = info; }
          cells.push(info); c0 += s;
        });
      });
      function keysOf(c) {
        var ks = [];
        if (c.k) ks.push({ k: c.k, kind: c.tm ? 'tm' : c.ox ? 'ox' : c.sel ? 'sel' : 'in', lab: '' });
        if (c.tpl) { var re = /\{(in|tm|sel):([\w]+)[^}]*\}/g, m, last = 0; while ((m = re.exec(c.tpl))) { var lab = c.tpl.slice(last, m.index).replace(/\{[^}]*\}/g, ' ').replace(/[\/∕]/g, ' ').replace(/\s+/g, ' ').trim(); ks.push({ k: m[2], kind: m[1], lab: lab }); last = re.lastIndex; } }
        return ks;
      }
      cells.forEach(function (info) {
        var ks = keysOf(info.c); if (!ks.length) return;
        var r = info.r0, left = [], up = [];
        for (var x = info.c0 - 1; x >= 0; x--) { var L = occ[r] && occ[r][x]; if (L && L !== info && L.text && !keysOf(L.c).length && left.indexOf(L.text) < 0) left.unshift(L.text); }
        var ncol = (b.w || []).length;
        function scanUp(O, y0, own) {
          for (var y = y0; y >= 0 && up.length < 3; y--) {
            var U = O[y] && O[y][info.c0]; if (!U || U === info) continue;
            var uk = keysOf(U.c);
            if (uk.length) { if (uk.some(function (q) { return q.kind === 'tm'; })) return true; continue; }   /* 시간 머리줄 = 경계 */
            if (U.s >= Math.max(info.s * 4, ncol * 0.6) && !up.length) return true;                       /* 구역 제목 = 경계 */
            if (U.text && up.indexOf(U.text) < 0) { up.unshift(U.text); if (U.s <= info.s + 2) return true; }
          }
          return up.length > 0;
        }
        var done = scanUp(occ, r - 1);
        /* 머리줄이 앞 표에 따로 있는 경우 (예: 근무일보) — 열 구성이 같으면 이어서 봄 */
        if (!done && !up.length) { var pt = prevTs.filter(function (q) { return q.ncol === ncol && q.ncol > 2; }).pop(); if (pt) scanUp(pt.occ, pt.occ.length - 1); }
        ks.forEach(function (k) {
          var row = left.join(' '), col = up.join(' ');
          out.push({ k: k.k, kind: k.kind, row: row, col: col, lab: k.lab || '', near: left[left.length - 1] || k.lab || '', blk: bi, r: r, spec: specOf(row) || specOf(col) || specOf(k.lab) });
        });
      });
      prevTs.push({ occ: occ, ncol: (b.w || []).length });
    });
    FCACHE[ck] = out;
    return out;
  }
  /* 기준 범위 읽기 — 숫자가 정확히 한 범위일 때만 */
  function specOf(t) {
    t = String(t || ''); if (!t) return null;
    var found = [], m, re;
    re = /(-?\d[\d,]*(?:\.\d+)?)\s*[~∼～]\s*(-?\d[\d,]*(?:\.\d+)?)\s*(℃|°C|초|bar|BAR|%)?/g;
    while ((m = re.exec(t))) found.push({ lo: +m[1].replace(/,/g, ''), hi: +m[2].replace(/,/g, ''), u: m[3] || '' });
    re = /\((-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*(℃|°C)\)/g;
    while ((m = re.exec(t))) found.push({ lo: +m[1], hi: +m[2], u: m[3] });
    re = /(\d+(?:\.\d+)?)\s*±\s*(\d+(?:\.\d+)?)/g;
    while ((m = re.exec(t))) found.push({ lo: +m[1] - +m[2], hi: +m[1] + +m[2], u: '' });
    re = /(\d+(?:\.\d+)?)\s*(℃|°C)?\s*이상/g;
    while ((m = re.exec(t))) found.push({ lo: +m[1], hi: null, u: m[2] || '' });
    re = /(\d+(?:\.\d+)?)\s*(℃|°C)?\s*이하/g;
    while ((m = re.exec(t))) found.push({ lo: null, hi: +m[1], u: m[2] || '' });
    if (found.length !== 1) return null;
    var f = found[0]; if (f.lo != null && f.hi != null && f.lo > f.hi) return null;
    f.txt = (f.lo != null && f.hi != null) ? f.lo + '~' + f.hi + f.u : (f.lo != null ? f.lo + f.u + ' 이상' : f.hi + f.u + ' 이하');
    return f;
  }

  /* ───────── 일지 → 팀 ───────── */
  var TEAM0 = { f6: '배합팀', f8: '배합팀', f9: '착즙팀', f10: '착즙팀', f11: '멸균팀', f14: '배합팀', f28: '착즙팀' };
  function teamOf(f) {
    if (!f) return '공통';
    if (f.jteam) return f.jteam; if (TEAM0[f.id]) return TEAM0[f.id]; if (f.team && TEAMS.indexOf(f.team) >= 0) return f.team;
    var n = f.name || '';
    if (/착즙/.test(n)) return '착즙팀'; if (/배합|설탕/.test(n)) return '배합팀';
    if (/멸균|Aseptic|HACCP 일보/.test(n)) return '멸균팀'; if (/포장|B호기|DE생산|용량/.test(n)) return '포장팀';
    return '공통';
  }
  function docDate(d) { return String((d.data && d.data.pdate) || d.savedAt || d.updatedAt || d.createdAt || '').slice(0, 10); }
  function shortName(n) { return String(n || '').replace(/\s*\(상온제품가공[^)]*\)/, '').replace(/^\[일반제품\]\s*/, ''); }

  /* ───────── 일지 내용 분석 ───────── */
  var NOTE_RE = /특이|개선\s*조치|정지\s*사유|사유|비\s*고|이탈|조치\s*사항|메모/;
  function analyzeDocs(data, from, to, templates) {
    var forms = {}; ((data && data.forms) || []).forEach(function (f) { forms[f.id] = f; });
    var docs = ((data && data.docs) || []).filter(function (d) { return d && !d.deleted && d.status !== 'draft' && d.status !== 'temp'; });
    var inP = docs.filter(function (d) { var x = docDate(d); return x >= from && x <= to; });
    var R = { docs: inP, byForm: {}, byTeam: {}, byDay: {}, devs: [], notes: [], ot: { total: 0, byTeam: {}, people: 0 }, heads: [], ster: {}, sterDay: {}, stops: [], ccpChecks: 0, pending: 0, completed: 0, rejected: 0, leadH: [] };
    inP.forEach(function (d) {
      var f = forms[d.formId] || { id: d.formId, name: d.title || '문서' }, team = teamOf(f), day = docDate(d);
      (R.byForm[f.id] = R.byForm[f.id] || { id: f.id, code: f.code, name: shortName(f.name), team: team, n: 0, days: {} }).n++;
      R.byForm[f.id].days[day] = (R.byForm[f.id].days[day] || 0) + 1;
      R.byTeam[team] = (R.byTeam[team] || 0) + 1;
      R.byDay[day] = (R.byDay[day] || 0) + 1;
      if (d.status === 'completed' || d.status === 'approved') R.completed++;
      else if (d.status === 'rejected') R.rejected++;
      else if (d.status === 'pending' || d.status === 'in_progress') R.pending++;
      var sg = d.signs || {}, w = sg.writer && sg.writer.at, ap = sg.approve && sg.approve.at;
      if (w && ap) { var h = (new Date(ap) - new Date(w)) / 3600000; if (h >= 0 && h < 24 * 30) R.leadH.push(h); }
      var grid = (d.data && d.data.grid) || {};
      var wt = (templates && f.code && templates[f.code]) || f.wtpl;
      var fields = introspect(f.code || f.id, wt);
      var isHaccp = /HACCP/.test(f.name || '');
      fields.forEach(function (fd) {
        var v = grid[fd.k]; if (v == null || v === '') return;
        var vs = String(v).trim(); if (!vs) return;
        var label = clip([fd.row, fd.col].filter(Boolean).join(' · ') || fd.lab || fd.near, 60);
        /* 판정 · 적합 여부 */
        if (/판정|적합|O\s*[/∕]\s*X|Leak/.test(fd.row + ' ' + fd.col + ' ' + fd.lab) || fd.kind === 'ox' || fd.kind === 'sel') {
          if (/판정|적합/.test(fd.row + fd.col + fd.lab) && isHaccp) R.ccpChecks++;
          if (/^(x|X|×|✕|부적합|NG)$/.test(vs)) R.devs.push({ d: day, form: shortName(f.name), team: team, what: label, val: vs, spec: '적합', kind: '부적합' });
          return;
        }
        /* 기준 범위 */
        if (fd.spec && fd.kind !== 'tm') {
          var n = num(vs);
          if (n != null) {
            if (isHaccp) R.ccpChecks++;
            var sp = fd.spec, bad = (sp.lo != null && n < sp.lo) || (sp.hi != null && n > sp.hi);
            if (bad) R.devs.push({ d: day, form: shortName(f.name), team: team, what: label, val: vs, spec: sp.txt, kind: '기준 이탈' });
            return;
          }
        }
        /* 현장 메모 */
        var lb = fd.row + ' ' + fd.col + ' ' + fd.lab;
        if (NOTE_RE.test(lb) && /[가-힣A-Za-z]/.test(vs) && vs.length >= 2) R.notes.push({ d: day, form: shortName(f.name), team: team, what: clip(fd.near || fd.lab || fd.row, 24), text: clip(vs, 120) });
        /* 근무일보: OT */
        if (/^OT$/i.test(fd.col.split(' ').pop() || '') || /\bOT\b/.test(fd.col)) { var hh = hoursOf(vs); if (hh > 0 && hh < 24) { R.ot.total += hh; R.ot.byTeam[team] = (R.ot.byTeam[team] || 0) + hh; R.ot.people++; } }
      });
      /* 근무일보: 인원 */
      if (/근무일보/.test(f.name || '')) {
        var tot = null, work = null, off = null;
        fields.forEach(function (fd) { var v = num(grid[fd.k]); if (v == null) return; var L = fd.near + ' ' + fd.lab; if (/총\s*인\s*원/.test(L)) tot = v; else if (/근무\s*인원/.test(L)) work = v; else if (/휴무\s*인원/.test(L)) off = v; });
        if (tot == null) { var tk = fields.filter(function (fd) { return /total/.test(fd.k); })[0]; if (tk) tot = num(grid[tk.k]); }
        R.heads.push({ d: day, team: team, total: tot, work: work, off: off });
      }
      /* 멸균 업무일지: 호기별 가동시간 · 적산량 · 배치 · 정지 */
      if (/멸균 파트|멸균파트/.test(f.name || '') || (f.code === 'FRM-016')) {
        var titles = [];
        if (wt && wt.blocks) wt.blocks.forEach(function (b) { (b.rows || []).forEach(function (r) { (r || []).forEach(function (c) { var t = cellText(c); if (/^멸균\s*\d\s*호기/.test(t)) titles.push(t.replace(/\s+/g, ' ')); }); }); });
        for (var s = 1; s <= 6; s++) {
          var p = 's' + s + '_', nm = titles[s - 1] || ('멸균 ' + s + '호기'), run = hoursOf(grid[p + 'run']), qty = num(grid[p + 'qty']), bat = num(grid[p + 'batch']);
          if (!run && !qty && !bat && !grid[p + 'item']) continue;
          var S = R.ster[nm] = R.ster[nm] || { run: 0, qty: 0, batch: 0, days: 0, items: {} };
          S.run += run || 0; S.qty += qty || 0; S.batch += bat || 0; S.days++;
          if (grid[p + 'item']) S.items[String(grid[p + 'item']).trim()] = 1;
          R.sterDay[day] = (R.sterDay[day] || 0) + (qty || 0);
          for (var j = 1; j <= 5; j++) { var st = grid[p + 'st' + j], why = grid[p + 'why' + j]; if (st || why) R.stops.push({ d: day, hogi: nm, start: st || '', end: grid[p + 'rs' + j] || '', min: rmins(st, grid[p + 'rs' + j]), why: why || '' }); }
        }
      }
    });
    R.pendingAll = docs.filter(function (d) { return d.status === 'pending' || d.status === 'in_progress'; }).length;
    return R;
  }

  /* ───────── 기간 지표 ───────── */
  function analyze(data, NF, P, opts) {
    var all = records(data, NF);
    var cur = all.filter(function (r) { return r.d >= P.from && r.d <= P.to; });
    var prv = all.filter(function (r) { return r.d >= P.pFrom && r.d <= P.pTo; });
    var days = range(P.from, P.to), pdays = range(P.pFrom, P.pTo);
    var dl = cur.filter(function (r) { return r.kind === 'delay'; }), ml = cur.filter(function (r) { return r.kind === 'maint'; });
    var pdl = prv.filter(function (r) { return r.kind === 'delay'; }), pml = prv.filter(function (r) { return r.kind === 'maint'; });
    var M = { P: P, days: days, delays: dl, maints: ml, delayN: dl.length, delayMin: sum(dl, function (r) { return r.min; }), maintN: ml.length,
      pDelayN: pdl.length, pDelayMin: sum(pdl, function (r) { return r.min; }), pMaintN: pml.length, pDays: pdays.length };
    if (P.kind === 'daily') { M.pDelayN = pdl.length / 7; M.pDelayMin = M.pDelayMin / 7; M.pMaintN = pml.length / 7; }
    M.div = {}; DIVS.forEach(function (dv) {
      var a = dl.filter(function (r) { return r.div === dv; }), b = pdl.filter(function (r) { return r.div === dv; });
      M.div[dv] = { n: a.length, min: sum(a, function (r) { return r.min; }), pn: b.length, pmin: sum(b, function (r) { return r.min; }) * (P.kind === 'daily' ? 1 / 7 : 1), maint: ml.filter(function (r) { return r.div === dv; }).length };
    });
    M.daily = days.map(function (d) { var o = { d: d }; DIVS.forEach(function (dv) { o[dv] = sum(dl.filter(function (r) { return r.d === d && r.div === dv; }), function (r) { return r.min; }); }); o.total = sum(DIVS, function (dv) { return o[dv]; }); o.n = dl.filter(function (r) { return r.d === d; }).length; o.m = ml.filter(function (r) { return r.d === d; }).length; return o; });
    M.reasons = topBy(dl, function (r) { return r.reason; }, function (r) { return r.min; }, 8);
    M.hogi = topBy(dl, function (r) { return (r.team || '') + ' ' + (r.hogi || ''); }, function (r) { return r.min; }, 6);
    M.products = topBy(dl, function (r) { return r.product; }, function (r) { return r.min; }, 6);
    M.big = dl.filter(function (r) { return (+r.min || 0) >= (P.kind === 'daily' ? 120 : 180); }).sort(function (a, b) { return (b.min || 0) - (a.min || 0); }).slice(0, P.kind === 'monthly' ? 8 : 6);
    M.mtype = topBy(ml, function (r) { return r.mtype || '기타'; }, null, 6);
    M.massets = topBy(ml, function (r) { return r.asset; }, null, 6);
    /* 시간대 */
    M.hours = []; for (var h = 0; h < 24; h += 2) M.hours.push({ h: h, min: sum(dl.filter(function (r) { var t = toMin(r.start); return t != null && t >= h * 60 && t < (h + 2) * 60; }), function (r) { return r.min; }) });
    /* 일지 */
    M.J = analyzeDocs(data, P.from, P.to, opts.templates);
    M.pJ = analyzeDocs(data, P.pFrom, P.pTo, opts.templates);
    /* 생산계획 (다음 기간) */
    var nxtFrom = addDays(P.to, 1), nxtTo = P.kind === 'daily' ? nxtFrom : (P.kind === 'weekly' ? addDays(nxtFrom, 6) : monthEnd(nxtFrom.slice(0, 7)));
    var plan = [];
    Object.keys((data && data.planWeeks) || {}).forEach(function (k) {
      var w = data.planWeeks[k], yr = (k.match(/^(\d{4})/) || [])[1] || nxtFrom.slice(0, 4);
      (w.cells || []).forEach(function (c) { var m = String(c.rowLabel || '').match(/^(\d{1,2})\/(\d{1,2})/); if (!m) return; var d = yr + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2); if (d >= nxtFrom && d <= nxtTo) plan.push(Object.assign({ d: d }, c)); });
    });
    M.plan = plan; M.planFrom = nxtFrom; M.planTo = nxtTo;
    return M;
  }

  /* ───────── 메일에서도 보이는 그림(표 기반) ───────── */
  function card(title, body, sub) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border-collapse:separate;background:#fff;border:1px solid ' + C.line + ';border-radius:14px"><tr><td style="padding:16px 18px">' +
      '<div style="font-size:15px;font-weight:800;color:' + C.navy + ';letter-spacing:-.2px">' + title + (sub ? ' <span style="font-size:12px;font-weight:600;color:' + C.mute + '">' + sub + '</span>' : '') + '</div>' +
      '<div style="margin-top:10px">' + body + '</div></td></tr></table>';
  }
  function two(a, b) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td valign="top" width="50%" style="padding-right:7px">' + a + '</td><td valign="top" width="50%" style="padding-left:7px">' + b + '</td></tr></table>';
  }
  function chg(cur, prev, lowerIsBetter, unit) {
    var d = delta(cur, prev);
    if (d == null) return '<span style="color:' + C.mute + '">신규</span>';
    if (d === 0) return '<span style="color:' + C.mute + '">— 지난 기간과 같음</span>';
    var up = d > 0, good = lowerIsBetter ? !up : up;
    return '<span style="color:' + (good ? C.green : C.red) + ';font-weight:700">' + (up ? '▲ ' : '▼ ') + Math.abs(d) + '%</span><span style="color:' + C.mute + '"> ' + (unit || '지난 기간 대비') + '</span>';
  }
  function kpis(items) {
    var w = Math.floor(100 / items.length);
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:6px 0;margin-top:12px"><tr>' + items.map(function (k) {
      return '<td valign="top" width="' + w + '%" style="background:#fff;border:1px solid ' + C.line + ';border-radius:14px;padding:13px 14px;border-top:4px solid ' + (k.color || C.navy) + '">' +
        '<div style="font-size:11.5px;color:' + C.mute + ';font-weight:700;letter-spacing:.02em">' + k.icon + ' ' + esc(k.label) + '</div>' +
        '<div style="font-size:24px;font-weight:800;color:' + C.ink + ';margin-top:4px;line-height:1.15;white-space:nowrap">' + k.value + '</div>' +
        '<div style="font-size:11.5px;margin-top:5px;line-height:1.45">' + (k.sub || '&nbsp;') + '</div></td>';
    }).join('') + '</tr></table>';
  }
  function hbars(rows, opts) { /* rows: [label, value, text, color] */
    opts = opts || {};
    if (!rows.length) return '<div style="font-size:13px;color:' + C.mute + '">기록 없음</div>';
    var mx = Math.max.apply(null, rows.map(function (r) { return +r[1] || 0; })) || 1;
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12.5px;table-layout:fixed">' + rows.map(function (r, i) {
      var w = Math.max(2, Math.round((+r[1] || 0) / mx * 100));
      return '<tr><td style="padding:4px 8px 4px 0;width:' + (opts.lw || 34) + '%;color:' + C.ink + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (opts.rank ? '<b style="color:' + C.gold + '">' + (i + 1) + '</b> ' : '') + esc(clip(r[0], opts.clip || 22)) + '</td>' +
        '<td style="padding:4px 0"><div style="width:' + w + '%;background:' + (r[3] || C.navy2) + ';height:14px;border-radius:7px;font-size:0;line-height:0">&nbsp;</div></td>' +
        '<td style="padding:4px 0 4px 8px;width:' + (opts.vw || 30) + '%;font-size:11.5px;color:' + C.mute + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + r[2] + '</td></tr>';
    }).join('') + '</table>';
  }
  function stack(parts, total) { /* 100% 막대 */
    var t = total || sum(parts, function (p) { return p[1]; }) || 1;
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:8px;overflow:hidden"><tr>' + parts.filter(function (p) { return p[1] > 0; }).map(function (p) {
      return '<td width="' + Math.max(1, Math.round(p[1] / t * 100)) + '%" style="background:' + p[2] + ';height:16px;font-size:0;line-height:0">&nbsp;</td>';
    }).join('') + '</tr></table><div style="margin-top:7px;font-size:12px;color:' + C.mute + '">' + parts.map(function (p) { return '<span style="display:inline-block;margin-right:12px;white-space:nowrap"><span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:' + p[2] + ';margin-right:4px"></span>' + esc(p[0]) + ' <b style="color:' + C.ink + '">' + (p[3] || p[1]) + '</b></span>'; }).join('') + '</div>';
  }
  function vbars(series, keys, colors, opts) { /* 날짜별 세로 막대 (쌓기) */
    opts = opts || {};
    var H = opts.h || 96, mx = Math.max.apply(null, series.map(function (s) { return sum(keys, function (k) { return s[k]; }); })) || 1;
    var many = series.length > 14;
    var cols = series.map(function (s) {
      var tot = sum(keys, function (k) { return s[k]; }), inner = '';
      keys.slice().reverse().forEach(function (k, i) { var v = +s[k] || 0; if (!v) return; var hh = Math.max(2, Math.round(v / mx * H)); inner += '<div style="height:' + hh + 'px;background:' + colors[keys.length - 1 - i] + ';font-size:0;line-height:0;' + (inner ? '' : 'border-radius:4px 4px 0 0;') + '">&nbsp;</div>'; });
      if (!inner) inner = '<div style="height:2px;background:#E3E7EF;font-size:0;line-height:0">&nbsp;</div>';
      var we = s.we ? 'color:' + C.red + ';' : '';
      return '<td valign="bottom" align="center" style="padding:0 ' + (many ? 1 : 4) + 'px;vertical-align:bottom">' +
        (opts.top && tot && !many ? '<div style="font-size:10.5px;color:' + C.mute + ';margin-bottom:3px;white-space:nowrap">' + opts.top(tot, s) + '</div>' : '') +
        '<div style="width:' + (many ? '70%' : '62%') + ';margin:0 auto">' + inner + '</div>' +
        '<div style="font-size:' + (many ? 9.5 : 11) + 'px;color:' + C.mute + ';margin-top:4px;white-space:nowrap;' + we + '">' + s.lab + '</div></td>';
    }).join('');
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed"><tr style="height:' + (H + 34) + 'px">' + cols + '</tr></table>' +
      (opts.legend ? '<div style="margin-top:8px;font-size:12px;color:' + C.mute + '">' + keys.map(function (k, i) { return '<span style="display:inline-block;margin-right:12px"><span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:' + colors[i] + ';margin-right:4px"></span>' + esc(opts.legend[i] || k) + '</span>'; }).join('') + '</div>' : '');
  }
  function heat(days, valf, labf) { /* 달력 (월~일) */
    var mx = Math.max.apply(null, days.map(valf)) || 1;
    var first = (dowN(days[0]) + 6) % 7, cells = [];
    for (var i = 0; i < first; i++) cells.push(null);
    days.forEach(function (d) { cells.push(d); });
    while (cells.length % 7) cells.push(null);
    var h = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:4px;table-layout:fixed;font-size:11px"><tr>' + '월화수목금토일'.split('').map(function (x, i) { return '<td align="center" style="color:' + (i >= 5 ? C.red : C.mute) + ';font-weight:700;padding-bottom:2px">' + x + '</td>'; }).join('') + '</tr>';
    for (var r = 0; r < cells.length; r += 7) {
      h += '<tr>' + cells.slice(r, r + 7).map(function (d) {
        if (!d) return '<td style="height:44px"></td>';
        var v = valf(d), a = v ? 0.12 + 0.88 * (v / mx) : 0;
        var bg = v ? 'rgba(214,69,69,' + a.toFixed(2) + ')' : '#F1F4F9', fg = a > 0.55 ? '#fff' : C.ink;
        return '<td valign="top" style="height:44px;background:' + bg + ';border-radius:8px;padding:5px 6px;color:' + fg + '"><div style="font-weight:800;font-size:11.5px">' + (+d.slice(8)) + '</div><div style="font-size:10.5px;margin-top:3px;white-space:nowrap">' + (v ? labf(d) : '') + '</div></td>';
      }).join('') + '</tr>';
    }
    return h + '</table><div style="font-size:11.5px;color:' + C.mute + ';margin-top:6px">색이 진할수록 지연 시간이 길었던 날 · 숫자는 그날 총 지연 시간</div>';
  }
  function matrix(rows, days) { /* 일지 작성 현황: 양식 × 날짜 */
    if (!rows.length) return '<div style="font-size:13px;color:' + C.mute + '">이 기간에 저장된 일지가 없습니다.</div>';
    var many = days.length > 10;
    var h = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:11.5px;table-layout:fixed"><tr><td style="width:' + (many ? 30 : 38) + '%"></td>' +
      days.map(function (d) { var w = dowN(d); return '<td align="center" style="color:' + (w === 0 || w === 6 ? C.red : C.mute) + ';font-size:' + (many ? 9 : 11) + 'px;padding-bottom:4px">' + (many ? (+d.slice(8)) : md(d) + '<br>' + dowOf(d)) + '</td>'; }).join('') + '<td align="right" style="width:9%;color:' + C.mute + ';font-size:11px">합계</td></tr>';
    rows.forEach(function (r) {
      h += '<tr><td style="padding:3px 6px 3px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + (TC[r.team] || C.mute) + ';margin-right:5px"></span>' + esc(clip(r.name, many ? 16 : 22)) + '</td>' +
        days.map(function (d) { var n = r.days[d] || 0; return '<td align="center" style="padding:2px 1px"><div style="height:' + (many ? 12 : 16) + 'px;border-radius:4px;background:' + (n ? (TC[r.team] || C.navy2) : '#EEF1F6') + ';' + (n ? '' : 'opacity:.9;') + 'font-size:0;line-height:0">&nbsp;</div></td>'; }).join('') +
        '<td align="right" style="font-weight:800;color:' + C.ink + '">' + r.n + '</td></tr>';
    });
    return h + '</table>';
  }
  function table(head, rows, opts) {
    opts = opts || {};
    if (!rows.length) return '<div style="font-size:13px;color:' + C.mute + '">' + (opts.empty || '기록 없음') + '</div>';
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12.5px"><tr>' + head.map(function (x) { return '<th align="left" style="background:' + C.soft + ';color:' + C.mute + ';font-weight:700;padding:7px 8px;border-bottom:1px solid ' + C.line + ';white-space:nowrap">' + x + '</th>'; }).join('') + '</tr>' +
      rows.map(function (r) { return '<tr>' + r.map(function (x) { return '<td valign="top" style="padding:7px 8px;border-bottom:1px solid #EEF1F5">' + x + '</td>'; }).join('') + '</tr>'; }).join('') + '</table>';
  }
  function chip(t, bg, fg) { return '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:' + bg + ';color:' + fg + ';font-size:11.5px;font-weight:700;white-space:nowrap">' + t + '</span>'; }
  function light(level) { return level === 2 ? chip('주의', C.redBg, C.red) : level === 1 ? chip('관찰', C.amberBg, '#B8701A') : chip('양호', C.greenBg, C.green); }

  /* ───────── 보고서 조립 ───────── */
  function compose(M, opts) {
    var P = M.P, kind = P.kind, J = M.J, pJ = M.pJ;
    var KN = { daily: '일일', weekly: '주간', monthly: '월간' }[kind];
    var nd = M.days.length;
    /* 부서별 상태 */
    var status = DIVS.map(function (dv) {
      var s = M.div[dv], base = s.pmin || 0, lv = 0;
      if (s.min >= 60 && s.min > base * 1.3) lv = s.min > base * 1.8 || s.min >= 240 * nd ? 2 : 1;
      return { dv: dv, s: s, lv: lv };
    });
    var devN = J.devs.length;
    var summary = KN + ' · 지연 ' + M.delayN + '건(' + hrs(M.delayMin) + ') · 정비 ' + M.maintN + '건 · 일지 ' + J.docs.length + '건' + (devN ? ' · 기준 이탈 ' + devN + '건' : '') + (J.pendingAll ? ' · 결재 대기 ' + J.pendingAll + '건' : '');
    if (M.reasons[0]) summary += ' · 최다 사유: ' + M.reasons[0][0];
    var title = { daily: '📋 ' + md(P.from) + '(' + dowOf(P.from) + ') 일일 보고', weekly: '📊 주간 보고 · ' + md(P.from) + '~' + md(P.to), monthly: '📈 월간 보고 · ' + P.label }[kind];

    var h = '<div style="font-family:' + FONT + ';color:' + C.ink + ';max-width:760px;margin:0 auto;background:' + C.soft + ';padding:14px;border-radius:18px">';
    /* 머리 */
    var accent = { daily: '#3B6FE0', weekly: '#7B5CD6', monthly: '#C8A15A' }[kind];
    h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-radius:16px;background:' + C.navy + ';background-image:linear-gradient(120deg,#0A142B 0%,#1B356F 60%,#24448C 100%)"><tr><td style="padding:22px 24px;color:#fff">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td><div style="font-size:11.5px;letter-spacing:.16em;color:' + C.gold2 + ';font-weight:800">연세우유 상온제품생산부문</div>' +
      '<div style="font-size:26px;font-weight:800;margin-top:6px;letter-spacing:-.4px">' + KN + ' 업무 보고</div>' +
      '<div style="font-size:14px;margin-top:4px;color:#C9D4EE">' + esc(P.label) + (kind !== 'daily' ? ' · ' + nd + '일' : '') + '</div></td>' +
      '<td align="right" valign="top"><span style="display:inline-block;padding:6px 12px;border-radius:999px;background:' + accent + ';color:#fff;font-size:12px;font-weight:800">' + KN + ' REPORT</span></td></tr></table>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;border-collapse:separate;border-spacing:0"><tr>' + status.map(function (x) {
        var col = x.lv === 2 ? '#FF8A8A' : x.lv === 1 ? '#FFC870' : '#7EE0A8';
        return '<td width="32%" style="padding:10px 12px;background:#22345F;background:rgba(255,255,255,.08);border-radius:10px;border-left:4px solid ' + col + '"><div style="font-size:11.5px;color:#C9D4EE">' + x.dv + ' · ' + DIVSUB[x.dv] + '</div><div style="font-size:15px;font-weight:800;margin-top:2px">' + (x.s.n ? x.s.n + '건 · ' + hrs(x.s.min) : '지연 없음') + '</div></td>' + (x.dv !== DIVS[DIVS.length - 1] ? '<td style="width:2%"></td>' : '');
      }).join('') + '</tr></table></td></tr></table>';
    /* AI 요약 */
    if (opts.ai) h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border-collapse:separate;background:#FFFDF6;border:1px solid #EFE3C8;border-left:5px solid ' + C.gold + ';border-radius:14px"><tr><td style="padding:15px 18px"><div style="font-size:12px;font-weight:800;color:#A9853F;letter-spacing:.06em">✦ AI 핵심 요약</div><div style="font-size:14px;line-height:1.8;margin-top:6px">' + mdLite(opts.ai) + '</div></td></tr></table>';

    /* KPI */
    var lead = J.leadH.length ? Math.round(sum(J.leadH) / J.leadH.length * 10) / 10 : null;
    var unit = kind === 'daily' ? '최근 7일 평균 대비' : kind === 'weekly' ? '지난주 대비' : '지난달 대비';
    h += kpis([
      { icon: '⏱', label: '생산 지연', value: M.delayN + '<span style="font-size:14px;color:' + C.mute + '">건</span>', sub: '<b>' + hrs(M.delayMin) + '</b><br>' + chg(M.delayMin, M.pDelayMin, true, unit), color: C.red },
      { icon: '🔧', label: '설비 정비', value: M.maintN + '<span style="font-size:14px;color:' + C.mute + '">건</span>', sub: chg(M.maintN, M.pMaintN, false, unit), color: C.teal },
      { icon: '📝', label: '작성된 일지', value: J.docs.length + '<span style="font-size:14px;color:' + C.mute + '">건</span>', sub: (kind === 'daily' ? '' : '하루 평균 ' + (Math.round(J.docs.length / nd * 10) / 10) + '건<br>') + chg(J.docs.length, kind === 'daily' ? pJ.docs.length / 7 : pJ.docs.length, false, unit), color: C.blue },
      { icon: '🛡', label: '기준 이탈 · 부적합', value: devN + '<span style="font-size:14px;color:' + C.mute + '">건</span>', sub: (J.ccpChecks ? 'HACCP 측정 ' + J.ccpChecks + '회 중<br>' : '') + (devN ? '<span style="color:' + C.red + ';font-weight:700">확인 필요</span>' : '<span style="color:' + C.green + ';font-weight:700">이탈 없음</span>'), color: devN ? C.red : C.green }
    ]);
    h += kpis([
      { icon: '✅', label: '결재', value: J.completed + '<span style="font-size:14px;color:' + C.mute + '">완료</span>', sub: '대기 <b>' + J.pendingAll + '</b>건' + (J.rejected ? ' · 반려 ' + J.rejected + '건' : '') + (lead != null ? '<br>작성→승인 평균 ' + lead + '시간' : ''), color: C.navy2 },
      { icon: '👥', label: '시간 외 근무(OT)', value: (Math.round(J.ot.total * 10) / 10) + '<span style="font-size:14px;color:' + C.mute + '">시간</span>', sub: Object.keys(J.ot.byTeam).map(function (t) { return t + ' ' + Math.round(J.ot.byTeam[t] * 10) / 10 + 'h'; }).join(' · ') || '근무일보 OT 기록 없음', color: '#7B5CD6' },
      { icon: '🏭', label: '멸균 적산량', value: fmtQty(sum(Object.keys(J.ster), function (k) { return J.ster[k].qty; })), sub: '가동 ' + (Math.round(sum(Object.keys(J.ster), function (k) { return J.ster[k].run; }) * 10) / 10) + '시간 · 배치 ' + sum(Object.keys(J.ster), function (k) { return J.ster[k].batch; }) + '<br>정지 ' + J.stops.length + '건', color: C.gold },
      { icon: '📅', label: kind === 'daily' ? '내일 생산계획' : (kind === 'weekly' ? '다음 주 생산계획' : '다음 달 생산계획'), value: M.plan.length + '<span style="font-size:14px;color:' + C.mute + '">건</span>', sub: M.plan.length ? Object.keys(groupBy(M.plan, 'colLabel')).length + '개 설비' : '등록된 계획 없음', color: '#2E9E6A' }
    ]);

    /* 지연 추이 */
    if (kind !== 'daily') {
      var ser = M.daily.map(function (o) { var w = dowN(o.d); return Object.assign({ lab: kind === 'weekly' ? md(o.d) + ' ' + dowOf(o.d) : String(+o.d.slice(8)), we: w === 0 || w === 6 }, o); });
      h += card('⏱ 날짜별 생산 지연', vbars(ser, DIVS, DIVS.map(function (d) { return DC[d]; }), { h: kind === 'weekly' ? 110 : 90, top: function (t) { return hshort(t); }, legend: DIVS.map(function (d) { return d + ' (' + DIVSUB[d] + ')'; }) }),
        '총 ' + hrs(M.delayMin) + ' · 하루 평균 ' + hrs(M.delayMin / nd));
    }
    if (kind === 'monthly') h += card('🗓 지연 달력', heat(M.days, function (d) { var o = M.daily.filter(function (x) { return x.d === d; })[0]; return o ? o.total : 0; }, function (d) { var o = M.daily.filter(function (x) { return x.d === d; })[0]; return hshort(o.total); }));
    /* 원인 · 부서 */
    var share = DIVS.map(function (dv) { return [dv, M.div[dv].min, DC[dv], hrs(M.div[dv].min)]; });
    var reasonRows = (function () { var tot = M.delayMin || 1, cum = 0; return M.reasons.map(function (r) { cum += r[1]; return [r[0], r[1], hshort(r[1]) + ' · ' + r[2] + '건 · <span style="color:#A9853F">' + pct(cum, tot) + '%</span>', r === M.reasons[0] ? C.red : C.navy2]; }); })();
    h += two(card('🎯 지연 원인 TOP', hbars(reasonRows, { rank: 1, lw: 36, vw: 34 }), '파레토'),
      card('🏷 부서 · 호기별', stack(share) + '<div style="height:12px"></div>' + hbars(M.hogi.map(function (r) { return [r[0], r[1], hshort(r[1]) + ' · ' + r[2] + '건', C.teal]; }), { lw: 34, vw: 26 })));
    if (kind !== 'daily' && M.products.length) h += two(card('🥛 지연이 많았던 제품', hbars(M.products.map(function (r) { return [r[0], r[1], hrs(r[1]), '#7B5CD6']; }), { lw: 40 })),
      card('🕑 시간대별 지연', vbars(M.hours.map(function (x) { return { lab: x.h + '시', v: x.min }; }), ['v'], [C.amber], { h: 70, top: function (t) { return hshort(t); } })));
    /* 큰 지연 */
    h += card('⚠ ' + (kind === 'daily' ? '2시간' : '3시간') + ' 이상 지연', table(['날짜', '부서 · 호기', '제품', '사유', '시간'], M.big.map(function (r) {
      return [md(r.d), esc(r.div) + '<br><span style="color:' + C.mute + '">' + esc((r.team || '') + ' ' + (r.hogi || '')) + '</span>', esc(clip(r.product || '-', 18)), esc(clip(r.reason || '-', 26)) + (r.detail ? '<div style="color:' + C.mute + ';font-size:11.5px;margin-top:2px">' + esc(clip(r.detail, 60)) + '</div>' : ''), '<b style="color:' + C.red + '">' + hrs(r.min) + '</b>'];
    }), { empty: '해당 지연 없음 👍' }));
    /* 일지 */
    var fr = Object.keys(J.byForm).map(function (k) { return J.byForm[k]; }).sort(function (a, b) { return TEAMS.indexOf(a.team) - TEAMS.indexOf(b.team) || b.n - a.n; });
    var tparts = TEAMS.filter(function (t) { return J.byTeam[t]; }).map(function (t) { return [t, J.byTeam[t], TC[t], J.byTeam[t] + '건']; });
    if (kind === 'daily') {
      h += card('📝 일지 작성 · 결재', (tparts.length ? stack(tparts) : '') + '<div style="height:10px"></div>' + table(['일지', '팀', '건수'], fr.slice(0, 14).map(function (r) { return [esc(r.name), chip(r.team, '#F1F3F8', TC[r.team] || C.mute), '<b>' + r.n + '</b>']; }), { empty: '저장된 일지 없음' }), '결재 대기 ' + J.pendingAll + '건');
    } else {
      var md2 = kind === 'monthly' ? M.days : M.days;
      h += card('📝 일지 작성 현황', (tparts.length ? stack(tparts) + '<div style="height:12px"></div>' : '') + matrix(fr.slice(0, kind === 'monthly' ? 18 : 22), md2), '칸이 채워진 날 = 그 일지를 작성한 날');
    }
    /* 품질 · HACCP */
    if (J.devs.length || J.ccpChecks) {
      var dg = topBy(J.devs, function (x) { return x.form; }, null, 6);
      h += card('🛡 품질 · HACCP 기준 이탈', (J.devs.length ? hbars(dg.map(function (r) { return [r[0], r[1], r[1] + '건', C.red]; }), { lw: 40 }) + '<div style="height:10px"></div>' : '') +
        table(['날짜', '일지', '항목', '값', '기준'], J.devs.slice(0, kind === 'monthly' ? 14 : 10).map(function (x) { return [md(x.d), esc(clip(x.form, 18)), esc(clip(x.what, 34)), '<b style="color:' + C.red + '">' + esc(x.val) + '</b>', esc(x.spec)]; }), { empty: 'HACCP 측정 ' + J.ccpChecks + '회 — 기준 이탈 없음 ✅' }),
        J.ccpChecks ? '측정 ' + J.ccpChecks + '회 · 이탈률 ' + (J.ccpChecks ? Math.round(J.devs.length / J.ccpChecks * 1000) / 10 : 0) + '%' : '');
    }
    /* 멸균 */
    var sk = Object.keys(J.ster);
    if (sk.length || J.stops.length) {
      var qmax = Math.max.apply(null, sk.map(function (k) { return J.ster[k].qty; })) || 1;
      h += card('🏭 멸균 호기별 가동', table(['호기', '가동 시간', '적산량', '배치', '품목'], sk.map(function (k) { var s = J.ster[k]; return ['<b>' + esc(k) + '</b>', (Math.round(s.run * 10) / 10) + '시간', '<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td width="' + Math.max(3, Math.round(s.qty / qmax * 100)) + '%" style="background:' + C.gold + ';height:10px;border-radius:5px;font-size:0">&nbsp;</td><td style="padding-left:6px;white-space:nowrap;font-size:12px">' + fmtQty(s.qty) + '</td></tr></table>', s.batch || '-', esc(clip(Object.keys(s.items).join(', '), 30))]; })) +
        (J.stops.length ? '<div style="font-weight:800;font-size:13px;margin:14px 0 6px;color:' + C.navy + '">정지 기록 ' + J.stops.length + '건</div>' + table(['날짜', '호기', '정지 → 재가동', '사유'], J.stops.slice(0, 10).map(function (s) { return [md(s.d), esc(s.hogi), esc(s.start) + ' → ' + esc(s.end) + (s.min ? ' <b>(' + hrs(s.min) + ')</b>' : ''), esc(clip(s.why, 40))]; })) : ''));
    }
    /* 인원 · OT */
    if (J.heads.length || J.ot.total) {
      var hb = {}; J.heads.forEach(function (x) { var b = hb[x.team] = hb[x.team] || { n: 0, w: 0, o: 0, t: 0 }; b.n++; b.w += x.work || 0; b.o += x.off || 0; b.t += x.total || 0; });
      h += card('👥 근무 인원 · 시간 외 근무', table(['팀', '근무일보', '평균 근무인원', '평균 휴무', '총 OT'], Object.keys(hb).map(function (t) { var b = hb[t]; return [chip(t, '#F1F3F8', TC[t] || C.mute), b.n + '건', b.w ? (Math.round(b.w / b.n * 10) / 10) + '명' : '-', b.o ? (Math.round(b.o / b.n * 10) / 10) + '명' : '-', '<b>' + (Math.round((J.ot.byTeam[t] || 0) * 10) / 10) + '시간</b>']; })));
    }
    /* 정비 */
    if (M.maints.length) {
      h += two(card('🔧 정비 종류', hbars(M.mtype.map(function (r) { return [r[0], r[1], r[1] + '건', C.teal]; }), { lw: 40 })),
        card('🔩 정비가 잦은 설비', hbars(M.massets.map(function (r) { return [r[0], r[1], r[1] + '건', '#5B7BB7']; }), { lw: 46, clip: 20 })));
      if (kind === 'daily') h += card('🔧 정비 내역', table(['설비', '내용', '종류', '담당'], M.maints.slice(0, 12).map(function (r) { return [esc(r.asset || '-'), esc(clip(r.content || '-', 40)), esc(r.mtype || '-'), esc(r.person || '')]; })));
    }
    /* 현장 메모 */
    if (J.notes.length) h += card('💬 현장 메모 · 특이사항', J.notes.slice(0, kind === 'daily' ? 10 : 14).map(function (n) {
      return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px"><tr><td width="4" style="background:' + (TC[n.team] || C.mute) + ';border-radius:3px;font-size:0">&nbsp;</td><td style="padding:2px 10px"><div style="font-size:11.5px;color:' + C.mute + '">' + md(n.d) + ' · ' + esc(n.form) + ' · ' + esc(n.what) + '</div><div style="font-size:13px;margin-top:2px">' + esc(n.text) + '</div></td></tr></table>';
    }).join(''), J.notes.length > 14 ? '외 ' + (J.notes.length - 14) + '건' : '');
    /* 다음 기간 생산계획 */
    var pb = groupBy(M.plan, 'colLabel'), pl = Object.keys(pb).sort();
    h += card('📅 ' + (kind === 'daily' ? md(M.planFrom) + '(' + dowOf(M.planFrom) + ') ' : (kind === 'weekly' ? '다음 주 (' + md(M.planFrom) + '~' + md(M.planTo) + ') ' : '다음 달 ')) + '생산계획',
      pl.length ? (kind === 'daily' ? table(['설비', '품목'], pl.map(function (l) { return ['<b>' + esc(l) + '</b>', pb[l].map(function (c) { return esc(c.code || '') + (c.batch ? ' &lt;' + esc(c.batch) + '&gt;' : '') + ' ' + esc(c.name || ''); }).join('<br>')]; }))
        : hbars(pl.map(function (l) { return [l, pb[l].length, pb[l].length + '건', '#2E9E6A']; }), { lw: 30 })) : '<div style="font-size:13px;color:' + C.mute + '">등록된 생산계획 없음</div>');
    h += '<div style="font-size:11.5px;color:' + C.mute + ';margin-top:16px;text-align:center;line-height:1.7">이 보고서는 업무포털의 일지 · 지연 · 정비 · 생산계획 데이터로 자동 생성되었습니다.' + (opts.portalUrl ? '<br><a href="' + esc(opts.portalUrl) + '#/reports?t=' + kind + '&amp;k=' + esc(P.key) + '" style="color:#2F5BD3;font-weight:700">포털에서 보기 →</a>' : '') + '</div></div>';
    return { title: title, summary: summary, html: h };
  }
  function groupBy(a, k) { var o = {}; a.forEach(function (x) { (o[x[k]] = o[x[k]] || []).push(x); }); return o; }
  function fmtQty(q) { q = +q || 0; if (!q) return '0'; return q >= 10000 ? (Math.round(q / 1000) / 10) + '만' : q.toLocaleString('ko-KR'); }

  function textOf(M) {
    var P = M.P, J = M.J, t = [];
    t.push('보고 종류: ' + { daily: '일일', weekly: '주간', monthly: '월간' }[P.kind] + ' / 기간: ' + P.from + ' ~ ' + P.to + ' (' + M.days.length + '일)');
    t.push('생산 지연: ' + M.delayN + '건, 총 ' + Math.round(M.delayMin) + '분 (비교 기간: ' + Math.round(M.pDelayN * 10) / 10 + '건, ' + Math.round(M.pDelayMin) + '분)');
    DIVS.forEach(function (dv) { var s = M.div[dv]; t.push('  [' + dv + ' ' + DIVSUB[dv] + '] ' + s.n + '건 ' + Math.round(s.min) + '분 (비교 ' + Math.round(s.pmin) + '분), 정비 ' + s.maint + '건'); });
    t.push('지연 원인 TOP: ' + M.reasons.map(function (r) { return r[0] + ' ' + Math.round(r[1]) + '분/' + r[2] + '건'; }).join(', '));
    t.push('호기별: ' + M.hogi.map(function (r) { return r[0] + ' ' + Math.round(r[1]) + '분'; }).join(', '));
    M.big.forEach(function (r) { t.push('  큰 지연: ' + [r.d, r.div, r.team, r.hogi, r.product, r.reason, r.min + '분', r.detail].filter(Boolean).join(' / ')); });
    t.push('정비: ' + M.maintN + '건 (종류: ' + M.mtype.map(function (r) { return r[0] + ' ' + r[1]; }).join(', ') + ')');
    if (P.kind === 'daily') M.maints.forEach(function (r) { t.push('  정비: ' + [r.asset, r.content, r.mtype].filter(Boolean).join(' / ')); });
    t.push('일지: ' + J.docs.length + '건 (팀별 ' + Object.keys(J.byTeam).map(function (k) { return k + ' ' + J.byTeam[k]; }).join(', ') + '), 결재 완료 ' + J.completed + ', 대기 ' + J.pendingAll + ', 반려 ' + J.rejected);
    t.push('HACCP 측정 ' + J.ccpChecks + '회, 기준 이탈·부적합 ' + J.devs.length + '건');
    J.devs.slice(0, 15).forEach(function (x) { t.push('  이탈: ' + x.d + ' ' + x.form + ' ' + x.what + ' 값 ' + x.val + ' (기준 ' + x.spec + ')'); });
    t.push('OT 합계 ' + Math.round(J.ot.total * 10) / 10 + '시간');
    Object.keys(J.ster).forEach(function (k) { var s = J.ster[k]; t.push('  멸균 ' + k + ': 가동 ' + Math.round(s.run * 10) / 10 + 'h, 적산량 ' + s.qty + ', 배치 ' + s.batch); });
    J.stops.slice(0, 10).forEach(function (s) { t.push('  정지: ' + s.d + ' ' + s.hogi + ' ' + s.start + '~' + s.end + ' ' + s.why); });
    J.notes.slice(0, 15).forEach(function (n) { t.push('  메모: ' + n.d + ' ' + n.form + ' ' + n.what + ': ' + n.text); });
    t.push('다음 기간 생산계획 ' + M.plan.length + '건');
    return t.join('\n');
  }

  /* opts: { kind, ref(기준일), date(일일 보고 대상일), ai, portalUrl, templates, sections, now } */
  function report(data, NF, opts) {
    opts = opts || {};
    var kind = opts.kind || 'daily';
    var P = kind === 'daily' ? period('daily', opts.date || kstDate(-1, opts.now)) : period(kind, opts.ref || kstDate(0, opts.now), opts.now);
    var M = analyze(data, NF, P, opts);
    var out = compose(M, opts);
    var J = M.J;
    return { kind: kind, key: P.key, date: P.key, from: P.from, to: P.to, label: P.label, title: out.title, summary: out.summary, html: out.html, text: textOf(M),
      stats: { from: P.from, to: P.to, delayN: M.delayN, delayMin: Math.round(M.delayMin), maintN: M.maintN, docs: J.docs.length, devs: J.devs.length, pending: J.pendingAll, ot: Math.round(J.ot.total * 10) / 10,
        totalN: M.delayN, totalMin: Math.round(M.delayMin), totalM: M.maintN, docsSaved: J.docs.length } };
  }
  /* 예전 방식 호환 (일일) */
  function build(data, NF, opts) { opts = Object.assign({}, opts || {}); opts.kind = 'daily'; return report(data, NF, opts); }

  /* ═════════ 자동 인사이트 (공지사항 「자동 인사이트」) ═════════
     하루(D)의 일지 · 지연 · 정비 기록을 최근 기간과 비교해 「확인할 일」을 찾아 글로 만듦.
     규칙으로 찾은 사실만 쓰고, 근거 숫자를 함께 둠.  level: red(즉시 확인) · amber(관찰) · green(참고 · 좋은 소식)
     같은 주제가 며칠 이어지면 새 글을 만들지 않고 기존 글을 갱신(key가 같고 최근 3일 안에 본 글)           */
  function seriesRows(data, from, to, templates) {
    /* 기준 범위가 있는 줄(예: HACCP 「멸균 TSL 42 135~150℃」)의 날짜별 평균값 */
    var forms = {}; ((data && data.forms) || []).forEach(function (f) { forms[f.id] = f; });
    var S = {};
    ((data && data.docs) || []).forEach(function (d) {
      if (!d || d.deleted || d.status === 'draft' || d.status === 'temp') return;
      var day = docDate(d); if (day < from || day > to) return;
      var f = forms[d.formId]; if (!f) return;
      var wt = (templates && f.code && templates[f.code]) || f.wtpl;
      var grid = (d.data && d.data.grid) || {};
      introspect(f.code || f.id, wt).forEach(function (fd) {
        if (!fd.spec || fd.kind === 'tm') return;
        var n = num(grid[fd.k]); if (n == null) return;
        var key = (f.code || f.id) + '|' + fd.row;
        var s = S[key] = S[key] || { form: shortName(f.name), team: teamOf(f), row: fd.row, spec: fd.spec, days: {} };
        (s.days[day] = s.days[day] || []).push(n);
      });
    });
    return S;
  }
  function lvMax(a, b) { var o = { green: 0, amber: 1, red: 2 }; return o[a] >= o[b] ? a : b; }

  function insights(data, NF, opts) {
    opts = opts || {};
    var D = opts.date || kstDate(-1, opts.now);
    var W0 = addDays(D, -6), P0 = addDays(D, -13), P1 = addDays(D, -7);
    var all = records(data, NF);
    var w = all.filter(function (r) { return r.d >= W0 && r.d <= D; });
    var p = all.filter(function (r) { return r.d >= P0 && r.d <= P1; });
    var out = [];
    function add(o) { o.d = D; out.push(o); }
    var link = '#/reports?t=daily&k=' + D;

    /* 1. 같은 설비 정비 반복 */
    topBy(w.filter(function (r) { return r.kind === 'maint'; }), function (r) { return String(r.asset || '').replace(/\s+/g, ' ').trim(); }, null, 20).forEach(function (g) {
      if (g[2] < 3) return;
      var list = w.filter(function (r) { return r.kind === 'maint' && String(r.asset || '').replace(/\s+/g, ' ').trim() === g[0]; });
      add({ key: 'maint|' + g[0], level: g[2] >= 4 ? 'red' : 'amber', cat: '설비', icon: '🔧', title: g[0] + ' — 최근 7일 정비 ' + g[2] + '회',
        body: '같은 설비에 정비가 반복되고 있습니다. 부품 교체만으로 끝나지 않는 근본 원인(설치 상태 · 운전 조건 · 예방 정비 주기)을 점검해 주세요.',
        lines: list.slice(0, 6).map(function (r) { return md(r.d) + ' · ' + (r.content || '-') + (r.mtype ? ' (' + r.mtype + ')' : ''); }),
        ev: [['정비 횟수', g[2] + '회 / 7일'], ['종류', topBy(list, function (r) { return r.mtype || '기타'; }, null, 3).map(function (x) { return x[0] + ' ' + x[1]; }).join(', ')]], link: '#/oplogs' });
    });
    /* 2. 같은 호기 지연 반복 */
    var dl5 = w.filter(function (r) { return r.kind === 'delay' && r.d >= addDays(D, -4); });
    var byH = {}; dl5.forEach(function (r) { var k = (r.team || r.div) + ' ' + (r.hogi || ''); (byH[k] = byH[k] || []).push(r); });
    Object.keys(byH).forEach(function (k) {
      var L = byH[k], days = {}; L.forEach(function (r) { days[r.d] = 1; });
      var nd = Object.keys(days).length; if (nd < 3) return;
      var mins = sum(L, function (r) { return r.min; }); if (mins < 180) return;
      var top = topBy(L, function (r) { return r.reason; }, function (r) { return r.min; }, 2);
      add({ key: 'hogi|' + k, level: nd >= 4 && mins >= 360 ? 'red' : 'amber', cat: '설비', icon: '⏱', title: k.trim() + ' — 최근 5일 중 ' + nd + '일 지연 (' + hrs(mins) + ')',
        body: '같은 호기에서 지연이 며칠째 이어지고 있습니다. 주요 원인: ' + top.map(function (t) { return t[0] + ' ' + hrs(t[1]); }).join(', ') + '.',
        lines: L.slice(-6).map(function (r) { return md(r.d) + ' ' + (r.start || '') + ' · ' + (r.reason || '-') + ' · ' + hrs(r.min) + (r.product ? ' · ' + r.product : ''); }),
        ev: [['지연 일수', nd + '일 / 5일'], ['총 지연', hrs(mins)]], link: '#/oplogs' });
    });
    /* 3. 멸균 정지 반복 · 일지 분석 */
    var J = analyzeDocs(data, W0, D, opts.templates);
    var stopBy = {}; J.stops.forEach(function (s) { (stopBy[s.hogi] = stopBy[s.hogi] || []).push(s); });
    Object.keys(stopBy).forEach(function (h) {
      var L = stopBy[h], days = {}; L.forEach(function (s) { days[s.d] = 1; }); var nd = Object.keys(days).length; if (nd < 3) return;
      var run = 0, ds = Object.keys(days).sort(), mx = 1; for (var i = 1; i < ds.length; i++) { run = addDays(ds[i - 1], 1) === ds[i] ? (run || 1) + 1 : 1; mx = Math.max(mx, run); }
      add({ key: 'stop|' + h, level: nd >= 4 || mx >= 3 ? 'red' : 'amber', cat: '설비', icon: '⛔', title: h + ' — 최근 7일 중 ' + nd + '일 정지' + (mx >= 3 ? ' (' + mx + '일 연속)' : ''),
        body: '멸균 파트 업무 일지에 정지 기록이 반복됩니다. 주요 사유: ' + (topBy(L, function (s) { return s.why || '사유 미기재'; }, null, 3).map(function (x) { return x[0] + ' ' + x[1] + '회'; }).join(', ')) + '.',
        lines: L.slice(-6).map(function (s) { return md(s.d) + ' ' + s.start + ' → ' + s.end + (s.min ? ' (' + hrs(s.min) + ')' : '') + ' · ' + (s.why || '사유 미기재'); }),
        ev: [['정지 일수', nd + '일 / 7일'], ['정지 기록', L.length + '건']], link: link });
    });
    /* 4. 어제 기준 이탈 · 부적합 */
    var dd = J.devs.filter(function (x) { return x.d === D; });
    var byF = {}; dd.forEach(function (x) { (byF[x.form] = byF[x.form] || []).push(x); });
    Object.keys(byF).forEach(function (f) {
      var L = byF[f];
      add({ key: 'dev|' + f + '|' + D, level: 'red', cat: '품질', icon: '🛡', title: f + ' — 기준 이탈 · 부적합 ' + L.length + '건',
        body: '일지에 적힌 값이 양식의 기준을 벗어났습니다. 한계기준 이탈 시 개선조치 기록이 있는지 확인해 주세요.',
        lines: L.slice(0, 6).map(function (x) { return clip(x.what, 46) + ' → ' + x.val + ' (기준 ' + x.spec + ')'; }),
        ev: [['이탈', L.length + '건'], ['날짜', md(D)]], link: link });
    });
    /* 5. 기준선에 다가가는 추세 (아직 기준 안) */
    var S = seriesRows(data, addDays(D, -6), D, opts.templates);
    Object.keys(S).forEach(function (k) {
      var s = S[k], ds = Object.keys(s.days).sort(); if (ds.length < 4 || ds[ds.length - 1] !== D) return;
      var v = ds.map(function (d) { var a = s.days[d]; return sum(a) / a.length; }), sp = s.spec, last = v[v.length - 1];
      if ((sp.lo != null && v.some(function (x) { return x < sp.lo; })) || (sp.hi != null && v.some(function (x) { return x > sp.hi; }))) return;
      var rng = (sp.lo != null && sp.hi != null) ? sp.hi - sp.lo : Math.abs((sp.lo != null ? sp.lo : sp.hi)) * 0.1 || 1;
      var t = v.slice(-4), down = t.every(function (x, i) { return !i || x <= t[i - 1]; }), up = t.every(function (x, i) { return !i || x >= t[i - 1]; });
      var toward = null;
      if (down && sp.lo != null && last - sp.lo <= rng * 0.15 && t[0] - last >= rng * 0.1) toward = '하한 ' + sp.lo;
      if (up && sp.hi != null && sp.hi - last <= rng * 0.15 && last - t[0] >= rng * 0.1) toward = '상한 ' + sp.hi;
      if (!toward) return;
      add({ key: 'trend|' + k, level: 'amber', cat: '품질 추세', icon: '📉', title: s.form + ' · ' + clip(s.row, 40) + ' — ' + toward + '에 가까워지는 중',
        body: '아직 기준 안이지만 ' + t.length + '일째 같은 방향으로 움직여 기준선에 가까워졌습니다. 센서 · 설정값 · 원료 상태를 미리 확인해 주세요.',
        lines: ds.slice(-5).map(function (d, i) { var a = s.days[d]; return md(d) + ' 평균 ' + Math.round(sum(a) / a.length * 10) / 10; }),
        ev: [['기준', sp.txt], ['어제 평균', Math.round(last * 10) / 10]], link: link });
    });
    /* 6. 지연 원인 급증 */
    var cr = {}, pr = {};
    w.filter(function (r) { return r.kind === 'delay'; }).forEach(function (r) { if (r.reason) cr[r.reason] = (cr[r.reason] || []).concat([r]); });
    p.filter(function (r) { return r.kind === 'delay'; }).forEach(function (r) { if (r.reason) pr[r.reason] = (pr[r.reason] || 0) + (+r.min || 0); });
    Object.keys(cr).forEach(function (rs) {
      var L = cr[rs], m = sum(L, function (r) { return r.min; }), pm = pr[rs] || 0;
      if (m < 180 || m < pm * 2) return;
      var wd = topBy(L, function (r) { return DOW[dowN(r.d)] + '요일'; }, function (r) { return r.min; }, 1)[0];
      var hh = topBy(L, function (r) { var t = toMin(r.start); return t == null ? '' : (Math.floor(t / 120) * 2) + '~' + (Math.floor(t / 120) * 2 + 2) + '시'; }, function (r) { return r.min; }, 1)[0];
      add({ key: 'reason|' + rs, level: m >= 600 && m >= pm * 3 ? 'red' : 'amber', cat: '지연', icon: '📈', title: '「' + rs + '」 지연이 ' + (pm ? Math.round(m / pm * 10) / 10 + '배로 증가' : '새로 크게 발생') + ' (' + hrs(m) + ')',
        body: '최근 7일 ' + L.length + '건, 지난 7일 ' + hrs(pm) + ' → 이번 7일 ' + hrs(m) + '.' + (wd ? ' ' + wd[0] + '에 가장 많았고' : '') + (hh && hh[0] ? ' 시간대는 ' + hh[0] + '에 몰렸습니다.' : ''),
        lines: L.slice(-5).map(function (r) { return md(r.d) + ' ' + (r.team || '') + ' ' + (r.hogi || '') + ' · ' + hrs(r.min) + (r.product ? ' · ' + r.product : ''); }),
        ev: [['이번 7일', hrs(m)], ['지난 7일', hrs(pm)]], link: '#/reports?t=weekly' });
    });
    /* 7. 일지 누락 (평소 쓰던 일지가 어제 없음) */
    if (dowN(D) !== 0) {
      var forms = {}; ((data && data.forms) || []).forEach(function (f) { forms[f.id] = f; });
      var hist = analyzeDocs(data, addDays(D, -14), addDays(D, -1), opts.templates), today = analyzeDocs(data, D, D, opts.templates);
      var work = range(addDays(D, -14), addDays(D, -1)).filter(function (d) { return dowN(d) !== 0; }).length || 1;
      var miss = Object.keys(hist.byForm).filter(function (id) { var b = hist.byForm[id]; return Object.keys(b.days).length >= work * 0.6 && !today.byForm[id]; }).map(function (id) { return hist.byForm[id]; });
      if (miss.length) add({ key: 'miss|' + D, level: 'amber', cat: '일지', icon: '📝', title: md(D) + '(' + dowOf(D) + ') 작성되지 않은 일지 ' + miss.length + '건',
        body: '평소 거의 매일 작성하던 일지가 이날은 저장되지 않았습니다. 작성 · 임시저장 상태를 확인해 주세요.',
        lines: miss.slice(0, 8).map(function (b) { return b.name + ' (' + b.team + ') · 최근 2주 ' + Object.keys(b.days).length + '일 작성'; }), ev: [['누락', miss.length + '건']], link: '#/journals' });
    }
    /* 8. 결재 지연 */
    var old = ((data && data.docs) || []).filter(function (d) { return d && (d.status === 'pending' || d.status === 'in_progress') && String(d.createdAt || d.savedAt || '').slice(0, 10) <= addDays(D, -3); });
    if (old.length) add({ key: 'appr', level: old.length >= 20 ? 'red' : 'amber', cat: '결재', icon: '✅', title: '3일 넘게 결재 대기 중인 문서 ' + old.length + '건',
      body: '결재가 늦어지면 일지 기록이 확정되지 않습니다. 전자결재 → 결재 대기에서 확인해 주세요.',
      lines: old.slice(0, 6).map(function (d) { return String(d.createdAt || '').slice(5, 10).replace('-', '/') + ' · ' + (d.title || d.docNo || '문서'); }), ev: [['대기', old.length + '건']], link: '#/approval' });
    /* 9. 좋은 소식 */
    DIVS.forEach(function (dv) {
      var n = 0; for (var i = 0; i < 30; i++) { var d = addDays(D, -i); if (all.some(function (r) { return r.kind === 'delay' && r.div === dv && r.d === d; })) break; n++; }
      var before = all.some(function (r) { return r.kind === 'delay' && r.div === dv && r.d < addDays(D, -n + 1) && r.d >= addDays(D, -n - 13); });
      if (n >= 5 && before) add({ key: 'good|' + dv, level: 'green', cat: '좋은 소식', icon: '🎉', title: dv + '(' + DIVSUB[dv] + ') ' + n + '일 연속 지연 없음',
        body: '최근 ' + n + '일 동안 생산 지연 기록이 없습니다. 잘 운영되고 있는 방식을 다른 라인에도 공유해 보세요.', lines: [], ev: [['연속', n + '일']], link: '#/reports?t=weekly' });
    });
    if (J.ccpChecks >= 20 && !J.devs.length) add({ key: 'good|haccp', level: 'green', cat: '좋은 소식', icon: '🏅', title: '최근 7일 HACCP · 기준 이탈 0건',
      body: '측정 ' + J.ccpChecks + '회 모두 기준 안이었습니다.', lines: [], ev: [['측정', J.ccpChecks + '회']], link: link });
    /* 알림 피로 줄이기: 🔴는 하루 최대 3개(나머지는 🟠), 전체 최대 10개(좋은 소식은 최대 2개 따로) */
    var ord = { red: 0, amber: 1, green: 2 }, wt = { '품질': 1, '설비': 2, '품질 추세': 3, '지연': 4, '일지': 5, '결재': 6 };
    out.sort(function (a, b) { return ord[a.level] - ord[b.level] || (wt[a.cat] || 9) - (wt[b.cat] || 9); });
    var reds = 0;
    out.forEach(function (x) { if (x.level === 'red') { reds++; if (reds > 3) x.level = 'amber'; } });
    out.sort(function (a, b) { return ord[a.level] - ord[b.level] || (wt[a.cat] || 9) - (wt[b.cat] || 9); });
    var main = out.filter(function (x) { return x.level !== 'green'; }).slice(0, 10), good = out.filter(function (x) { return x.level === 'green'; }).slice(0, 2);
    return main.concat(good);
  }
  /* 저장소에 합치기 — 같은 주제(key)를 최근 3일 안에 본 글이 있으면 갱신, 없으면 새 글. 60일 지난 글은 정리 */
  function mergeInsights(store, list, D, nowIso) {
    store = store || {}; var items = Object.assign({}, store.items || {}); var added = [];
    nowIso = nowIso || new Date().toISOString();
    list.forEach(function (x) {
      var hit = null;
      Object.keys(items).forEach(function (id) { var it = items[id]; if (it.key === x.key && it.status !== 'done' && it.last >= addDays(D, -3) && it.first <= D) hit = it; });
      if (hit) {
        if (hit.last >= D && hit.gen === D) return;
        var nl = lvMax(hit.level, x.level);
        items[hit.id] = Object.assign({}, hit, { title: x.title, body: x.body, lines: x.lines, ev: x.ev, link: x.link, level: nl, last: D > hit.last ? D : hit.last, days: (hit.days || 1) + (D > hit.last ? 1 : 0), gen: D, updatedAt: nowIso });
        if (nl === 'red' && hit.level !== 'red') added.push(items[hit.id]);
      } else {
        var id = x.key + '|' + D;
        if (items[id]) return;
        items[id] = Object.assign({ id: id, first: D, last: D, days: 1, gen: D, status: 'open', createdAt: nowIso, updatedAt: nowIso, notes: [] }, x);
        added.push(items[id]);
      }
    });
    var cut = addDays(D, -60);
    Object.keys(items).forEach(function (id) { if (items[id].last < cut && !items[id].pinned) delete items[id]; });
    return { store: Object.assign({}, store, { items: items, lastD: (!store.lastD || D > store.lastD) ? D : store.lastD }), added: added };
  }
  var AI_INSIGHT = '당신은 연세우유 상온제품생산부문의 설비 · 품질 데이터 분석 담당자입니다. 아래는 일지 · 지연 · 정비 기록에서 규칙으로 찾은 오늘의 인사이트 목록입니다. 이 목록만 근거로, 현장 관리자가 아침에 읽을 「오늘의 한 줄 브리핑」을 한국어 2~3문장으로 쓰세요. 가장 급한 것부터, 숫자는 그대로, 목록에 없는 내용은 쓰지 마세요.';

  var AI_BASE = '당신은 연세우유 상온제품생산부문의 생산관리 보고 담당자입니다. 주어진 데이터만 근거로 한국어로 요약하세요. 데이터에 없는 내용은 추측하지 말고, 기록이 없으면 "특이사항 없음"이라고 쓰세요. ';
  var AI = {
    daily: AI_BASE + '부서장이 아침에 1분 안에 읽을 수 있게 3~6개의 짧은 글머리표(•)로: 가장 큰 문제(시간 기준), 반복 원인, 평소보다 늘어난 부서, 기준 이탈, 오늘 확인할 점을 우선합니다.',
    weekly: AI_BASE + '지난 한 주를 돌아보는 주간 보고 요약입니다. 4~7개의 글머리표(•)로: 한 주 총평(지난주 대비 증감), 가장 큰 손실 원인과 호기, 품질·HACCP 이탈, 반복되는 정비, 일지·결재 상황, 다음 주에 집중할 점(제안 1~2개)을 씁니다.',
    monthly: AI_BASE + '지난달 월간 보고 요약입니다. 5~8개의 글머리표(•)로: 월 총평(지난달 대비 증감 %), 손실이 컸던 원인 TOP3와 비중, 문제가 몰린 주·요일·시간대, 품질·HACCP, 설비 정비 경향, 인력(OT), 다음 달 개선 과제 2~3개를 씁니다.'
  };
  AI.insight = AI_INSIGHT;
  var AI_SYSTEM = AI.daily;

  return { insights: insights, mergeInsights: mergeInsights, AI_INSIGHT: AI_INSIGHT, build: build, report: report, period: period, records: records, analyze: analyze, introspect: introspect, specOf: specOf,
    kstDate: kstDate, addDays: addDays, isoWeek: isoWeek, AI: AI, AI_SYSTEM: AI_SYSTEM, DIVS: DIVS };
});
