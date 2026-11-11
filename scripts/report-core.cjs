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
  var DIVSUB = { '가공2팀': '착즙 · 배합', '가공1팀': '멸균', '포장팀': '포장' };
  var TEAMS = ['착즙팀', '배합팀', '멸균팀', '포장팀', '공통'];
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
    /* 포털에서 고친 노션 기록(수정본) 반영 + 지연 사유 이름 정정 */
    var ED = (data && data.opEdits) || {}, ids = [];
    (NF.delay || []).forEach(function (r) { ids.push('N-' + r[10]); }); (NF.delay1 || []).forEach(function (r) { ids.push('N-' + r[10]); }); (NF.maint || []).forEach(function (r) { ids.push('N-' + r[7]); });
    out = out.map(function (o, i) { var e = ED[ids[i]]; if (e && e.f) { o = Object.assign({}, o, e.f); if (o.min !== '' && o.min != null) o.min = +o.min; } if (o.reason && /^\s*탈피실\s*PLC\s*기판\s*오류\s*$/.test(o.reason)) o.reason = 'E/V 108 OCR 교체'; return o; });
    ((data && data.opLogs) || []).forEach(function (o) {
      if (!o || !o.d || o.deleted) return;
      if (o.kind === 'delay') out.push({ div: o.div || '가공2팀', kind: 'delay', src: 'web', d: o.d, team: o.team || '', hogi: o.hogi || '', product: o.product || '', reason: /^\s*탈피실\s*PLC\s*기판\s*오류\s*$/.test(o.reason || '') ? 'E/V 108 OCR 교체' : (o.reason || ''), start: o.start || '', end: o.end || '', min: (o.totalMin !== '' && o.totalMin != null) ? +o.totalMin : rmins(o.start, o.end), detail: o.detail || '' });
      else out.push({ div: o.div || '가공2팀', kind: 'maint', src: 'web', d: o.d, asset: o.asset || '', content: o.content || '', mtype: o.mtype || '', person: o.person || '', etc: o.etc || '' });
    });
    return out;
  }

  /* ───────── 일지 양식 읽기: 입력칸마다 줄 이름 · 열 머리 · 기준 범위 ───────── */
  var FCACHE = {};
  function cellText(c) {
    if (c.lab) return String(c.dv || '').trim();   /* 근무일보 명단: 직급 · 이름 입력칸(기본값) */
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
        if (c.lab) return ks;
        if (c.k) ks.push({ k: c.k, kind: c.tm ? 'tm' : c.ox ? 'ox' : c.sel ? 'sel' : 'in', lab: '' });
        if (c.tpl) { var re = /\{(in|tm|sel):([\w]+)[^}]*\}/g, m, last = 0; while ((m = re.exec(c.tpl))) { var lab = c.tpl.slice(last, m.index).replace(/\{[^}]*\}/g, ' ').replace(/[\/∕]/g, ' ').replace(/\s+/g, ' ').trim(); ks.push({ k: m[2], kind: m[1], lab: lab }); last = re.lastIndex; } }
        if (c.tpl && /\{cv:/.test(c.tpl)) { var mc = c.tpl.match(/\{cv:(\w+):[^}]*:h\}/); if (mc) ks.push({ k: mc[1], kind: 'sel', lab: 'CIP 종류' }); }   /* CIP 종류(알칼리 · FULL) */
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
    /* 한 칸에 값 두 개(압력/온도 등)를 적는 줄은 값마다 기준을 따로 (HACCP B호기 CCP-3B) */
    if (code === 'FRM-025') {
      var S2 = { 12: [{ lo: 3, hi: 6, u: 'bar', txt: '3~6bar' }, { lo: null, hi: 21, u: '℃', txt: '21℃ 이하' }], 13: [null, { lo: 108, hi: 130, u: '℃', txt: '108~130℃' }],
        15: [{ lo: 350, hi: 370, u: '℃', txt: '350~370℃' }, { lo: 350, hi: 370, u: '℃', txt: '350~370℃' }], 16: [{ lo: 80, hi: null, u: '℃', txt: '80℃ 이상' }, { lo: 200, hi: null, u: 'pa', txt: '200pa 이상' }],
        20: [null, { lo: 100, hi: null, u: '%', txt: '조도 100% 이상' }], 21: [null, null] };
      out.forEach(function (x) { var m = String(x.k).match(/^p25_(\d+)_\d+_([12])$/); if (m && S2[m[1]]) x.spec = S2[m[1]][+m[2] - 1] || null; });
    }
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
  var TEAM0 = { f6: '착즙팀', f7: '착즙팀', f8: '착즙팀', f9: '착즙팀', f10: '착즙팀', f11: '멸균팀', f12: '배합팀', f14: '배합팀', f15: '착즙팀', f28: '착즙팀' };
  function teamOf(f) {
    if (!f) return '공통';
    if (f.code === 'FRM-008' || f.id === 'f8' || /설탕\s*용해/.test(f.name || '')) return '착즙팀';   /* 설탕 용해 기록 일보 = 착즙팀 */
    if (f.jteam) return f.jteam; if (TEAM0[f.id]) return TEAM0[f.id]; if (f.team && TEAMS.indexOf(f.team) >= 0) return f.team;
    var n = f.name || '';
    if (/착즙|설탕/.test(n)) return '착즙팀'; if (/배합/.test(n)) return '배합팀';
    if (/멸균|Aseptic|HACCP 일보/.test(n)) return '멸균팀'; if (/포장|B호기|DE생산|용량/.test(n)) return '포장팀';
    return '공통';
  }
  function docDate(d) { return String((d.data && d.data.pdate) || d.savedAt || d.updatedAt || d.createdAt || '').slice(0, 10); }
  function shortName(n) { return String(n || '').replace(/\s*\(상온제품가공[^)]*\)/, '').replace(/^\[일반제품\]\s*/, ''); }

  /* ───────── 일지 내용 분석 ───────── */
  var NOTE_RE = /특이|개선\s*조치|정지\s*사유|사유|비\s*고|이탈|조치\s*사항|메모/;
  function analyzeDocs(data, from, to, templates) {
    var forms = {}; ((data && data.forms) || []).forEach(function (f) { forms[f.id] = f; });
    var docs = ((data && data.docs) || []).filter(function (d) { return d && !d.deleted; });   /* 임시저장 일지도 포함 (작성 중인 그날 일지) */
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

  /* ───────── 착즙 · 배합 공정 요약 (포털 「생산계획 › 착즙 · 배합」 대시보드와 같은 계산) ───────── */
  function proc(data, from, to, templates) {
    var forms = {}; ((data && data.forms) || []).forEach(function (f) { if (f.code) forms[f.code] = f; });
    function latest(code) { var f = forms[code], m = {}; if (!f) return m;
      var L = {}; ((data && data.docs) || []).forEach(function (d) { if (!d || d.deleted || d.formId !== f.id || !d.data) return; var k = docDate(d); if (k < from || k > to) return; (L[k] = L[k] || []).push(d); });
      /* 같은 날 여러 장이면 칸마다 적힌 값을 합침 (같은 칸은 나중에 저장한 값) */
      Object.keys(L).forEach(function (k) { var a = L[k].sort(function (x, y) { return String(x.updatedAt || '').localeCompare(String(y.updatedAt || '')); }), last = a[a.length - 1];
        if (a.length === 1) { m[k] = last; return; } var gg = {}; a.forEach(function (d) { var G0 = (d.data && d.data.grid) || {}; Object.keys(G0).forEach(function (q) { var val = G0[q]; if (val != null && String(val).trim() !== '') gg[q] = val; }); });
        m[k] = Object.assign({}, last, { data: Object.assign({}, last.data, { grid: gg }) }); });
      return m; }
    function F(code) { var f = forms[code]; if (!f) return []; var wt = (templates && templates[code]) || f.wtpl; return wt ? introspect(code, wt) : []; }
    function g(d, k) { var x = ((d && d.data && d.data.grid) || {})[k]; return x == null ? '' : String(x).trim(); }
    function n(d, k) { var m = g(d, k).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; }
    function tot(a) { var s = 0, c = 0; a.forEach(function (x) { if (x != null && !isNaN(x)) { s += x; c++; } }); return c ? s : null; }
    function mean(a) { var b = a.filter(function (x) { return x != null && !isNaN(x); }); return b.length ? b.reduce(function (p, c) { return p + c; }, 0) / b.length : null; }
    var sp = function (x) { return String(x || '').replace(/\s+/g, ''); };
    var oxF = F('FRM-012').filter(function (x) { return x.kind === 'ox'; }), sF = F('FRM-008');
    var M12 = latest('FRM-012'), M8 = latest('FRM-008'), M9 = latest('FRM-009'), M10 = latest('FRM-010');
    /* 같은 날 · 같은 호기끼리만 합침 (B · D호기 공용 Check List · HACCP는 호기 칸으로 나눔) */
    var CKHO = { 'FRM-024': 'p24_ho', 'FRM-025': 'p25_ho', 'FRM-026': '', 'FRM-055': 'A', 'FRM-056': 'C', 'FRM-057': 'F', 'FRM-058': 'F', 'FRM-059': 'A', 'FRM-062': 'E', 'FRM-063': 'E' };
    function latestHo(code) { var f = forms[code], m = {}; if (!f) return m; var hk = CKHO[code] || '', L = {};
      ((data && data.docs) || []).forEach(function (d) { if (!d || d.deleted || d.formId !== f.id || !d.data) return; var k = docDate(d); if (k < from || k > to) return;
        var ho = /_ho$/.test(hk) ? (g(d, hk) || 'B') : hk; var key = k + '|' + ho; (L[key] = L[key] || []).push(d); });
      Object.keys(L).forEach(function (key) { var a = L[key].sort(function (x, y) { return String(x.updatedAt || '').localeCompare(String(y.updatedAt || '')); }), last = a[a.length - 1], gg = {};
        a.forEach(function (d) { var G0 = (d.data && d.data.grid) || {}; Object.keys(G0).forEach(function (q) { var val = G0[q]; if (val != null && String(val).trim() !== '') gg[q] = val; }); });
        var D = key.split('|')[0], ho = key.split('|')[1]; (m[D] = m[D] || []).push({ ho: ho, d: Object.assign({}, last, { data: Object.assign({}, last.data, { grid: gg }) }) }); });
      return m; }
    var M23 = latest('FRM-023'), CK = ['FRM-024', 'FRM-025', 'FRM-026', 'FRM-055', 'FRM-056', 'FRM-057', 'FRM-058', 'FRM-059', 'FRM-062', 'FRM-063'].map(latestHo);
    var mix = {}, juice = {}, pack = {};
    Object.keys(M12).forEach(function (D) { var d = M12[D], nb = 0, b1 = [], q = [], x = 0;
      for (var r = 10; r <= 24; r++) { var row = [1, 2, 3, 6, 8, 9, 10, 11, 13, 15].map(function (c) { return g(d, 'g2_' + r + '_' + c); }); if (row.some(Boolean)) { nb++; b1.push(n(d, 'g2_' + r + '_8')); } }
      for (var h = 1; h <= 5; h++) for (var rr = 3; rr <= 6; rr++) q.push(n(d, 'g2_' + rr + '_' + (2 * h + 1)));
      oxF.forEach(function (f) { if (/^[xX×]$/.test(g(d, f.k))) x++; });
      mix[D] = { nb: nb, q: tot(q), b1: mean(b1), x: x }; });
    Object.keys(M8).forEach(function (D) { var s = M8[D]; (juice[D] = juice[D] || {}).sug = tot(sF.filter(function (f) { return /설탕투입/.test(sp(f.col)); }).map(function (f) { return n(s, f.k); })); });
    Object.keys(M9).forEach(function (D) { var d = M9[D], use = n(d, 'g4_7_3'); if (use == null) use = tot([n(d, 'g4_5_3'), n(d, 'g4_6_3')]);
      var by = tot(['g4_5_8', 'g4_5_9', 'g4_5_10', 'g4_5_11', 'g4_5_12'].map(function (k) { return n(d, k); })), ph = 0, stop = 0;
      for (var l = 1; l <= 4; l++) for (var h = 0; h <= 24; h++) { var c = g(d, 'ax' + l + '_' + h).toLowerCase().replace(/[ㅁㅠㅊㅇㄷㄹㅎㅗㅓ]/g, function (q) { return { 'ㅁ': 'a', 'ㅠ': 'b', 'ㅊ': 'c', 'ㅇ': 'd', 'ㄷ': 'e', 'ㄹ': 'f', 'ㅎ': 'g', 'ㅗ': 'h', 'ㅓ': 'j' }[q]; }); c = c.replace(/[^a-j]/g, '').slice(0, 1); if (c === 'b') ph++; else if (/^[chj]$/.test(c)) stop++; }
      juice[D] = Object.assign(juice[D] || {}, { use: use, by: by, rate: use && by != null ? by / use * 100 : null, prodH: ph, stopH: stop }); });
    Object.keys(M10).forEach(function (D) { var o = M10[D], raw = n(o, 'g3_12_15'); if (raw == null) raw = tot([n(o, 'g3_12_12'), n(o, 'g3_12_13'), n(o, 'g3_12_14')]);
      var ts = []; for (var r = 10; r <= 22; r++) ts.push(n(o, 'g3_' + r + '_6'));
      var j = juice[D] = juice[D] || {}; j.raw = raw; j.ts = mean(ts); });
    /* 포장 (두유포장 B호기 생산작업일보 · Check List · HACCP CCP-3B · DE생산) */
    Object.keys(M23).forEach(function (D) { var d = M23[D], ea = n(d, 'p23_37_7'), box = n(d, 'p23_37_4');
      if (ea == null) ea = tot([32, 33, 34, 35, 36].map(function (r) { return n(d, 'p23_' + r + '_7'); }));
      if (box == null) box = tot([32, 33, 34, 35, 36].map(function (r) { return n(d, 'p23_' + r + '_4'); }));
      var sn = n(d, 'p23_32_12_3'), sm = n(d, 'p23_32_12_4');
      if (sn == null) { sn = 0; for (var r = 7; r <= 11; r++) if (g(d, 'p23_' + r + '_0')) sn++; }
      pack[D] = { ea: ea, box: box, rate: n(d, 'p23_32_12_5'), stopN: sn, stopMin: sm, ln: { B: ea } }; });
    /* A · C · E호기 생산작업일보 생산량을 더해 전 호기 합계로 (가동률 · 정지는 B호기 기준 그대로) */
    /* [호기, 양식, 입력칸 앞글자, 품명 열, Box 열, 개 열, 품명 첫 줄, 끝 줄, 합계 줄(없으면 null)] */
    [['A', 'FRM-045', 'p45', 0, 3, 8, 32, 35, 36], ['C', 'FRM-046', 'p46', 0, 4, 7, 32, 36, 37], ['D', 'FRM-049', 'p49', 0, 4, 7, 31, 36, null], ['E', 'FRM-047', 'p47', 0, 3, 8, 32, 35, 36], ['F', 'FRM-050', 'p50', 0, 4, 7, 36, 39, null]].forEach(function (L) {
      var M = latest(L[1]), P = L[2];
      Object.keys(M).forEach(function (D) { var d = M[D], rr = [], q;
        for (q = L[6]; q <= L[7]; q++) rr.push(q);
        var ea = L[8] ? n(d, P + '_' + L[8] + '_' + L[5]) : null, box = L[8] ? n(d, P + '_' + L[8] + '_' + L[4]) : null;
        if (ea == null) ea = tot(rr.map(function (r) { return n(d, P + '_' + r + '_' + L[5]); }));
        if (box == null) box = tot(rr.map(function (r) { return n(d, P + '_' + r + '_' + L[4]); }));
        var o = pack[D] = pack[D] || {}; o.ln = o.ln || {}; o.ln[L[0]] = ea;
        if (ea != null) o.ea = (o.ea || 0) + ea; if (box != null) o.box = (o.box || 0) + box; }); });
    /* 밀봉 공정 중간검사 & 불량팩 (테트라 B·C·D·F · SIG A·E): 그날 문서 모두(호기마다 한 장)의 불량 합계 · 호기별 */
    [['FRM-048', 'p48'], ['FRM-065', 'p65']].forEach(function (W) { var f = forms[W[0]], P = W[1]; if (!f) return;
      ((data && data.docs) || []).forEach(function (d) { if (!d || d.deleted || d.formId !== f.id || !d.data) return; var D = docDate(d); if (D < from || D > to) return;
        function rs(y) { var t = n(d, P + '_' + y + '_29'), t2 = y === 17 ? n(d, P + '_17b_29') : null; if (t != null || t2 != null) return (t || 0) + (t2 || 0); var a = []; for (var x = 2; x <= 28; x++) { a.push(n(d, P + '_' + y + '_' + x)); if (y === 17) a.push(n(d, P + '_17b_' + x)); } return tot(a); }
        var ft = rs(18); if (ft == null) { var a = []; for (var y = 7; y <= 17; y++) a.push(rs(y)); ft = tot(a); }
        if (ft != null) { var o = pack[D] = pack[D] || {}, ho = g(d, P + '_ho') || '?'; o.waste = (o.waste || 0) + ft; o.wasteBy = o.wasteBy || {}; o.wasteBy[ho] = (o.wasteBy[ho] || 0) + ft; } }); });
    CK.forEach(function (M) { Object.keys(M).forEach(function (D) { M[D].forEach(function (it) { var gr = (it.d.data && it.d.data.grid) || {}, x = 0;
      Object.keys(gr).forEach(function (k) { if (/^(x|×|불량|부적합|NG)$/i.test(String(gr[k]).trim())) x++; });
      var o = pack[D] = pack[D] || {}; o.bad = (o.bad || 0) + x; if (x) { var ho = it.ho || 'DE'; o.badBy = o.badBy || {}; o.badBy[ho] = (o.badBy[ho] || 0) + x; } }); }); });
    function S(o, k, f) { var a = Object.keys(o).map(function (D) { return o[D][k]; }); return f === 'avg' ? mean(a) : tot(a); }
    return { mix: mix, juice: juice, pack: pack,
      packSum: { days: Object.keys(pack).length, ea: S(pack, 'ea'), box: S(pack, 'box'), rate: S(pack, 'rate', 'avg'), stopN: S(pack, 'stopN'), stopMin: S(pack, 'stopMin'), bad: S(pack, 'bad'), waste: S(pack, 'waste'),
        badBy: (function () { var o = {}; Object.keys(pack).forEach(function (D) { var b = pack[D].badBy || {}; Object.keys(b).forEach(function (h) { o[h] = (o[h] || 0) + b[h]; }); }); return o; })(),
        wasteBy: (function () { var o = {}; Object.keys(pack).forEach(function (D) { var b = pack[D].wasteBy || {}; Object.keys(b).forEach(function (h) { o[h] = (o[h] || 0) + b[h]; }); }); return o; })(),
        ln: ['A', 'B', 'C', 'D', 'E', 'F'].map(function (h) { return [h, tot(Object.keys(pack).map(function (D) { return (pack[D].ln || {})[h]; }))]; }).filter(function (x) { return x[1] != null; }) },
      mixSum: { days: Object.keys(mix).length, nb: S(mix, 'nb'), q: S(mix, 'q'), b1: S(mix, 'b1', 'avg'), sug: S(mix, 'sug'), x: S(mix, 'x') },
      juiceSum: { days: Object.keys(juice).length, sug: S(juice, 'sug'), use: S(juice, 'use'), by: S(juice, 'by'), prodH: S(juice, 'prodH'), stopH: S(juice, 'stopH'), raw: S(juice, 'raw'), ts: S(juice, 'ts', 'avg') } };
  }
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
    M.PR = proc(data, P.from, P.to, opts.templates);
    M.pPR = proc(data, P.pFrom, P.pTo, opts.templates);
    M.L = labor(data, P.from, P.to, opts.templates); M.pL = labor(data, P.pFrom, P.pTo, opts.templates); M.K = kpiSum(data);
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

  /* ═════════ 보고서 v2 (2026-11-11) — 전문 보고서 형식 · 근무일보 인시 · 노무비 · KPI · 작성 현황 반영 ═════════ */
  /* 근무일보 7종: 줄마다 이름 · 근무시간(OT 포함) · OT · 심야 · 식사 칸 위치 (이름 칸 기준 몇 칸 뒤) */
  var LAB_LAY = { m14: [3, 4, 5, 7], m28: [3, 4, 5, 7], m66: [3, 4, 6, 8], m70: [3, 4, 6, 8], m67: [3, 4, 5, 8], m68: [3, 4, 5, 8], m69: [3, 4, 5, 8] };
  var LAB_DIV = { 'FRM-014': '가공2팀', 'FRM-028': '가공2팀', 'FRM-066': '가공1팀', 'FRM-070': '가공1팀', 'FRM-067': '포장팀', 'FRM-068': '포장팀', 'FRM-069': '포장팀' };
  function gridDay(d) { var g = (d && d.data && d.data.grid) || {}; if (g.dY && g.dM && g.dD && +g.dM >= 1 && +g.dM <= 12 && +g.dD >= 1 && +g.dD <= 31) return g.dY + '-' + ('0' + (+g.dM)).slice(-2) + '-' + ('0' + (+g.dD)).slice(-2); return docDate(d); }
  function labor(data, from, to, templates) {
    var forms = {}; ((data && data.forms) || []).forEach(function (f) { if (f && f.code) forms[f.code] = f; });
    var out = { byDiv: {}, byDay: {}, total: { pd: 0, h: 0, ot: 0, ng: 0, ml: [0, 0, 0, 0], tr: 0 }, people: {}, wage: null, otR: 1.5, ngR: 0.5 };
    var cfg = (data && data.kpiCfg) || {}; out.wage = +cfg.wage > 0 ? +cfg.wage : null; out.otR = +cfg.ot || 1.5; out.ngR = cfg.night != null ? +cfg.night : 0.5;
    var trn = ((data && data.trainees) || []).filter(function (x) { return x && x.n && x.off !== true; });
    function num(v) { var m = String(v == null ? '' : v).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; }
    function ate(v) { v = String(v == null ? '' : v).trim(); return !!v && !/^(x|X|0|-|×|N)$/.test(v); }
    Object.keys(LAB_DIV).forEach(function (code) {
      var f = forms[code]; if (!f) return; var wt = (templates && templates[code]) || f.wtpl; if (!wt || !wt.blocks) return; var rows = [];
      wt.blocks.forEach(function (b) { (b.rows || []).forEach(function (r) { var ks = (r || []).filter(function (c) { return c && c.k; }).map(function (c) { return c.k; }), ni = -1; ks.forEach(function (k, x) { if (/^m\d+_nm\d+$/.test(k)) ni = x; }); if (ni < 0) return; var L = LAB_LAY[ks[ni].split('_')[0]]; if (!L) return; rows.push({ nm: ks[ni], wk: ks[ni + L[0]], ot: ks[ni + L[1]], ng: ks[ni + L[2]], ml: [0, 1, 2, 3].map(function (j) { return ks[ni + L[3] + j]; }) }); }); });
      var last = {};
      ((data && data.docs) || []).forEach(function (d) { if (!d || d.deleted || d.status === 'deleted' || d.formId !== f.id || !d.data) return; var D = gridDay(d); if (!D || D < from || D > to) return; if (last[D] && String(last[D].updatedAt || '') > String(d.updatedAt || '')) return; last[D] = d; });
      var dv = LAB_DIV[code];
      Object.keys(last).forEach(function (D) { var d = last[D], g = (d.data && d.data.grid) || {};
        var tr = trn.filter(function (x) { return (!x.from || D >= x.from) && (!x.to || D <= x.to); }).map(function (x) { return String(x.n).replace(/\s+/g, ''); });
        rows.forEach(function (r) { var n = String(g[r.nm] || '').replace(/\s+/g, ''); if (!n) return; var h = num(g[r.wk]), ot = num(g[r.ot]), ng = num(g[r.ng]); if (h == null && ot == null && ng == null) return;
          ot = ot || 0; ng = ng || 0; if (h == null) h = 8 + ot;
          var o = out.byDiv[dv] = out.byDiv[dv] || { pd: 0, h: 0, ot: 0, ng: 0, ml: [0, 0, 0, 0], people: {} }, y = out.byDay[D] = out.byDay[D] || { h: 0, ot: 0, ng: 0, pd: 0, div: {} };
          o.pd++; o.h += h; o.ot += ot; o.ng += ng; o.people[n] = 1; y.pd++; y.h += h; y.ot += ot; y.ng += ng; y.div[dv] = (y.div[dv] || 0) + h;
          out.total.pd++; out.total.h += h; out.total.ot += ot; out.total.ng += ng; if (tr.indexOf(n) >= 0) out.total.tr += h;
          var p = out.people[n] = out.people[n] || { n: n, dv: dv, h: 0, ot: 0, ng: 0, d: 0 }; p.h += h; p.ot += ot; p.ng += ng; p.d++;
          r.ml.forEach(function (k, j) { if (k && ate(g[k])) { o.ml[j]++; out.total.ml[j]++; } }); }); }); });
    function cost(x) { return out.wage ? Math.max(0, x.h - x.ot) * out.wage + x.ot * out.wage * out.otR + x.ng * out.wage * out.ngR : null; }
    Object.keys(out.byDiv).forEach(function (k) { out.byDiv[k].cost = cost(out.byDiv[k]); out.byDiv[k].n = Object.keys(out.byDiv[k].people).length; });
    Object.keys(out.byDay).forEach(function (k) { out.byDay[k].cost = cost(out.byDay[k]); });
    out.total.cost = cost(out.total); out.total.n = Object.keys(out.people).length; out.total.days = Object.keys(out.byDay).length;
    return out;
  }
  /* 작성중 · 저장완료 (포털과 같은 규칙: 11/11 이후 일지는 서명도 인쇄도 없으면 작성중) */
  var PH_CUT = '2026-11-10T15:00:00Z';
  function signedDoc(d) { var s = d && d.signs; if (!s) return false; return Object.keys(s).some(function (k) { var v = s[k]; return v && (typeof v !== 'object' || v.img || v.name || v.src || v.data || Object.keys(v).length); }); }
  function writingDoc(d) { if (!d) return false; if (d.status === 'temp' || d.status === 'draft') return true; return d.status === 'saved' && String(d.createdAt || '') >= PH_CUT && !signedDoc(d) && !d.printedAt; }
  /* KPI (팀장이 올린 KPI 실적 엑셀) */
  function kpiSum(data) {
    var B = (data && data.kpiBooks) || {}, out = [];
    [['가공1팀', '상온제품가공1팀'], ['가공2팀', '상온제품가공2팀'], ['포장팀', '상온제품포장팀']].forEach(function (t) {
      var a = (B[t[0]] || {}).act; if (!a || !a.items || !a.items.length) { out.push({ k: t[0], label: t[1], none: true }); return; }
      var items = a.items, sc = a.total != null ? a.total : sum(items, function (i) { return i.score; }), lv = function (i) { if (i.score == null || !i.w) return null; var r = i.score / i.w; return r >= 0.999 ? 1 : r >= 0.899 ? 2 : r >= 0.799 ? 3 : r >= 0.699 ? 4 : 5; };
      out.push({ k: t[0], label: t[1], score: sc, n: items.length, lv1: items.filter(function (i) { return lv(i) === 1; }).length, warn: items.filter(function (i) { var v = lv(i); return v >= 4; }).map(function (i) { return { name: i.name, score: i.score, w: i.w }; }), ms: a.monthScore || [] }); });
    return out;
  }

  /* ───────── 디자인 (메일에서도 깨지지 않는 표 기반) ───────── */
  var V = { bg: '#EEF1F6', ink: '#0B1426', sub: '#475467', mute: '#7A8599', line: '#E4E8EF', card: '#FFFFFF', navy: '#0B1B3A', navy2: '#1D3A7A', gold: '#C8A15A', goodBg: '#E8F6EF', good: '#14804A', warnBg: '#FFF4E0', warn: '#B45309', badBg: '#FDECEC', bad: '#C2362F', accent: '#2F5BD8' };
  var PC = { juice: '#D98A1F', mix: '#7B5CD6', ster: '#12A39A', pack: '#3062D8' };
  function sec(no, title, sub) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:26px 0 2px;border-collapse:collapse"><tr>' +
      '<td width="34" valign="middle"><div style="width:28px;height:28px;line-height:28px;border-radius:8px;background:' + V.navy + ';color:#fff;font-size:12px;font-weight:800;text-align:center;font-family:' + FONT + '">' + no + '</div></td>' +
      '<td valign="middle" style="font-family:' + FONT + '"><span style="font-size:17px;font-weight:800;color:' + V.ink + ';letter-spacing:-.3px">' + title + '</span>' + (sub ? '<span style="font-size:12px;color:' + V.mute + ';margin-left:8px">' + sub + '</span>' : '') + '</td></tr>' +
      '<tr><td colspan="2" style="padding-top:8px"><div style="height:2px;background:' + V.line + ';font-size:0;line-height:0"><div style="width:64px;height:2px;background:' + V.gold + ';font-size:0;line-height:0">&nbsp;</div></div></td></tr></table>';
  }
  function box(title, body, sub, accent) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-collapse:separate;background:' + V.card + ';border:1px solid ' + V.line + ';border-radius:14px' + (accent ? ';border-top:3px solid ' + accent : '') + '"><tr><td style="padding:15px 18px;font-family:' + FONT + '">' +
      (title ? '<div style="font-size:13.5px;font-weight:800;color:' + V.ink + '">' + title + (sub ? ' <span style="font-size:11.5px;font-weight:600;color:' + V.mute + '">' + sub + '</span>' : '') + '</div><div style="height:10px;font-size:0;line-height:0">&nbsp;</div>' : '') + body + '</td></tr></table>';
  }
  function pill(t, bg, fg) { return '<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:' + bg + ';color:' + fg + ';font-size:11px;font-weight:800;white-space:nowrap">' + t + '</span>'; }
  function dpill(cur, prev, lowerBetter) {
    var d = delta(cur, prev); if (d == null) return pill('신규', '#EEF1F6', V.mute); if (d === 0) return pill('변동 없음', '#EEF1F6', V.mute);
    var up = d > 0, good = lowerBetter ? !up : up; return pill((up ? '▲ ' : '▼ ') + Math.abs(d) + '%', good ? V.goodBg : V.badBg, good ? V.good : V.bad);
  }
  function mini(vals, color) { /* 작은 추세 막대 */
    var v = vals.map(function (x) { return +x || 0; }), mx = Math.max.apply(null, v.concat([0])); if (!mx || v.length < 2) return '';
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;margin-top:8px"><tr style="height:26px">' + v.map(function (x, i) {
      var h = x ? Math.max(2, Math.round(x / mx * 24)) : 1; return '<td valign="bottom" style="padding:0 1px;vertical-align:bottom"><div style="height:' + h + 'px;background:' + (x ? color : '#E4E8EF') + ';opacity:' + (i === v.length - 1 ? 1 : 0.55) + ';border-radius:2px 2px 0 0;font-size:0;line-height:0">&nbsp;</div></td>'; }).join('') + '</tr></table>';
  }
  function tiles(items) {
    var out = '', w = Math.floor(100 / 4);
    for (var i = 0; i < items.length; i += 4) {
      out += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:6px 0;margin-top:10px"><tr>' + items.slice(i, i + 4).map(function (k) {
        return '<td valign="top" width="' + w + '%" style="background:' + V.card + ';border:1px solid ' + V.line + ';border-radius:14px;padding:13px 14px 11px;font-family:' + FONT + '">' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:11px;color:' + V.mute + ';font-weight:800;letter-spacing:.02em"><span style="display:inline-block;width:7px;height:7px;border-radius:2px;background:' + (k.color || V.navy) + ';margin-right:6px;vertical-align:1px"></span>' + esc(k.label) + '</td><td align="right">' + (k.badge || '') + '</td></tr></table>' +
          '<div style="font-size:24px;font-weight:800;color:' + V.ink + ';margin-top:6px;line-height:1.1;white-space:nowrap;letter-spacing:-.5px">' + k.value + '</div>' +
          '<div style="font-size:11.5px;color:' + V.sub + ';margin-top:5px;line-height:1.45;min-height:16px">' + (k.sub || '&nbsp;') + '</div>' + (k.spark || '') + '</td>'; }).join('') +
        (items.length - i < 4 ? new Array(4 - (items.length - i) + 1).join('<td width="' + w + '%"></td>') : '') + '</tr></table>';
    }
    return out;
  }
  function nv(x, s) { return x == null || x === 0 && s === 'z' ? '<span style="font-size:15px;color:#9AA4B5;font-weight:700">기록 없음</span>' : s; }
  function u(t) { return '<span style="font-size:13px;color:' + V.mute + ';font-weight:700;margin-left:2px">' + t + '</span>'; }
  function f1(x, dg) { return x == null || isNaN(x) ? '—' : (Math.round(x * Math.pow(10, dg || 0)) / Math.pow(10, dg || 0)).toLocaleString('ko-KR'); }
  function won(v) { if (v == null) return '-'; if (Math.abs(v) >= 1e8) return f1(v / 1e8, 2) + '억'; if (Math.abs(v) >= 1e4) return f1(v / 1e4, 0) + '만'; return f1(v, 0); }

  /* ───────── 보고서 조립 ───────── */
  function compose(M, opts) {
    var P = M.P, kind = P.kind, J = M.J, pJ = M.pJ, L = M.L, pL = M.pL, PR = Object.assign({ mix: {}, juice: {}, pack: {} }, M.PR || {}), PM = PR.mixSum || {}, PJ = PR.juiceSum || {}, PK = PR.packSum || {}, pPR = M.pPR || {}, pPK = pPR.packSum || {}, pPJ = pPR.juiceSum || {}, pPM = pPR.mixSum || {};
    var KN = { daily: '일일', weekly: '주간', monthly: '월간' }[kind], EN = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' }[kind];
    var nd = M.days.length, many = kind !== 'daily', dayDiv = kind === 'daily' ? 7 : 1;
    var unit = kind === 'daily' ? '최근 7일 평균 대비' : kind === 'weekly' ? '지난주 대비' : '지난달 대비';
    var status = DIVS.map(function (dv) { var s = M.div[dv], base = s.pmin || 0, lv = 0; if (s.min >= 60 && s.min > base * 1.3) lv = s.min > base * 1.8 || s.min >= 240 * nd ? 2 : 1; return { dv: dv, s: s, lv: lv }; });
    var devN = J.devs.length, wr = J.docs.filter(writingDoc).length, saved = J.docs.length - wr;
    var sterQ = sum(Object.keys(J.ster), function (k) { return J.ster[k].qty; }), sterRun = sum(Object.keys(J.ster), function (k) { return J.ster[k].run; });
    var worst = Math.max.apply(null, status.map(function (x) { return x.lv; }).concat([devN ? 1 : 0, (M.big || []).length ? 1 : 0]));
    var ST = worst >= 2 ? ['주의 필요', '#FF8A8A', V.badBg, V.bad] : worst === 1 ? ['관찰 필요', '#FFC870', V.warnBg, V.warn] : ['정상 운영', '#7EE0A8', V.goodBg, V.good];
    var summary = KN + ' · 지연 ' + M.delayN + '건(' + hrs(M.delayMin) + ') · 정비 ' + M.maintN + '건 · 일지 ' + J.docs.length + '건' + (devN ? ' · 기준 이탈 ' + devN + '건' : '') + (L.total.h ? ' · 투입 ' + f1(L.total.h, 0) + 'h' : '');
    if (M.reasons[0]) summary += ' · 최다 사유: ' + M.reasons[0][0];
    var title = { daily: '📋 ' + md(P.from) + '(' + dowOf(P.from) + ') 일일 업무 보고', weekly: '📊 주간 업무 보고 · ' + md(P.from) + '~' + md(P.to), monthly: '📈 월간 업무 보고 · ' + P.label }[kind];
    var series = function (f) { return M.days.map(f); };
    var SN = 0, S = function (t, s) { SN++; return sec((SN < 10 ? '0' : '') + SN, t, s); };

    var h = '<div style="font-family:' + FONT + ';color:' + V.ink + ';max-width:760px;margin:0 auto;background:' + V.bg + ';padding:16px;border-radius:20px">';
    /* ── 머리 ── */
    h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-radius:18px;background:' + V.navy + ';background-image:linear-gradient(125deg,#050C1F 0%,#0B1B3A 45%,#1D3A7A 100%)"><tr><td style="padding:24px 26px 20px;color:#fff;font-family:' + FONT + '">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td valign="top"><div style="font-size:11px;letter-spacing:.2em;color:' + V.gold + ';font-weight:800">YONSEI MILK · AMBIENT PRODUCTION DIVISION</div>' +
      '<div style="font-size:28px;font-weight:800;margin-top:8px;letter-spacing:-.6px">' + KN + ' 업무 보고</div>' +
      '<div style="font-size:13.5px;margin-top:6px;color:#B9C6E4">' + esc(P.label) + (many ? ' · ' + nd + '일' : '') + ' · 상온제품생산부문</div></td>' +
      '<td align="right" valign="top" style="white-space:nowrap"><div style="display:inline-block;padding:5px 11px;border-radius:999px;border:1px solid rgba(255,255,255,.28);font-size:10.5px;font-weight:800;letter-spacing:.14em;color:#DCE4F5">' + EN + ' REPORT</div>' +
      '<div style="margin-top:10px"><span style="display:inline-block;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.1);font-size:12.5px;font-weight:800;color:#fff"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + ST[1] + ';margin-right:6px"></span>' + ST[0] + '</span></div></td></tr></table>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border-collapse:separate;border-spacing:0"><tr>' + status.map(function (x, i) {
        var col = x.lv === 2 ? '#FF8A8A' : x.lv === 1 ? '#FFC870' : '#7EE0A8', ld = (L.byDiv[x.dv] || {});
        return (i ? '<td style="width:2%"></td>' : '') + '<td width="32%" valign="top" style="padding:11px 13px;background:#1A2C55;background:rgba(255,255,255,.07);border-radius:12px;border-left:3px solid ' + col + '"><div style="font-size:11px;color:#AFC0E3;font-weight:700">' + x.dv + ' · ' + DIVSUB[x.dv] + '</div>' +
          '<div style="font-size:15.5px;font-weight:800;margin-top:3px">' + (x.s.n ? '지연 ' + x.s.n + '건 · ' + hrs(x.s.min) : '지연 없음') + '</div>' +
          '<div style="font-size:11px;color:#AFC0E3;margin-top:3px">정비 ' + x.s.maint + '건' + (ld.h ? ' · 투입 ' + f1(ld.h, 0) + 'h' : '') + '</div></td>'; }).join('') + '</tr></table></td></tr></table>';

    /* ── 한눈에 보기 ── */
    var bl = [];
    bl.push('생산 지연 <b>' + M.delayN + '건 · ' + hrs(M.delayMin) + '</b>' + (M.reasons[0] ? ' — 가장 큰 원인 <b>' + esc(M.reasons[0][0]) + '</b> (' + hrs(M.reasons[0][1]) + ')' : ''));
    var prodBits = []; if (PJ.use) prodBits.push('대두 ' + f1(PJ.use) + 'kg'); if (PM.nb) prodBits.push('배합 ' + f1(PM.nb) + '배치'); if (sterQ) prodBits.push('멸균 ' + fmtQty(sterQ)); if (PK.ea) prodBits.push('포장 ' + f1(PK.ea) + '개');
    if (prodBits.length) bl.push('생산 실적 — ' + prodBits.join(' · '));
    bl.push(devN ? '품질 기준 이탈 <b style="color:' + V.bad + '">' + devN + '건</b> 확인 필요' : '품질 · HACCP 기준 이탈 <b style="color:' + V.good + '">없음</b>' + (J.ccpChecks ? ' (측정 ' + J.ccpChecks + '회)' : ''));
    if (L.total.h) bl.push('투입 인시 <b>' + f1(L.total.h, 1) + '시간</b> (연인원 ' + L.total.pd + '명 · OT ' + f1(L.total.ot, 1) + 'h)' + (L.total.cost != null ? ' · 추정 노무비 <b>' + won(L.total.cost) + '원</b>' : ''));
    h += box('', '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td valign="top" style="font-family:' + FONT + '"><div style="font-size:11px;font-weight:800;letter-spacing:.14em;color:' + V.gold + '">EXECUTIVE SUMMARY</div><div style="font-size:16px;font-weight:800;margin-top:4px">한눈에 보기</div></td><td align="right" valign="top">' + pill(ST[0], ST[2], ST[3]) + '</td></tr></table>' +
      '<div style="margin-top:10px;font-size:13.5px;line-height:1.85;color:' + V.ink + '">' + bl.map(function (x) { return '<div><span style="color:' + V.gold + ';font-weight:800;margin-right:6px">●</span>' + x + '</div>'; }).join('') + '</div>' +
      (opts.ai ? '<div style="margin-top:12px;padding:12px 14px;border-radius:12px;background:#FFFBF0;border:1px solid #F1E4C6"><div style="font-size:11px;font-weight:800;letter-spacing:.08em;color:#A9853F">✦ AI 분석 요약</div><div style="font-size:13.5px;line-height:1.8;margin-top:5px">' + mdLite(opts.ai) + '</div></div>' : ''), '', V.gold);

    /* ── 01 핵심 지표 ── */
    var sp = function (f, c) { return many ? mini(series(f), c) : ''; };
    var dmin = function (d) { var o = M.daily.filter(function (x) { return x.d === d; })[0]; return o ? o.total : 0; };
    h += S('핵심 지표', unit + ' 증감');
    h += tiles([
      { label: '생산 지연', color: V.bad, value: M.delayN + u('건'), badge: dpill(M.delayMin, M.pDelayMin, true), sub: '<b>' + hrs(M.delayMin) + '</b>', spark: sp(dmin, V.bad) },
      { label: '설비 정비', color: '#12A39A', value: M.maintN + u('건'), badge: dpill(M.maintN, M.pMaintN, false), sub: M.massets[0] ? '최다 ' + esc(clip(M.massets[0][0], 12)) : '&nbsp;', spark: sp(function (d) { var o = M.daily.filter(function (x) { return x.d === d; })[0]; return o ? o.m : 0; }, '#12A39A') },
      { label: '품질 이탈', color: devN ? V.bad : V.good, value: devN + u('건'), badge: devN ? pill('확인', V.badBg, V.bad) : pill('이상 없음', V.goodBg, V.good), sub: J.ccpChecks ? 'HACCP 측정 ' + J.ccpChecks + '회' : '&nbsp;' },
      { label: '일지 작성', color: V.accent, value: J.docs.length + u('건'), badge: dpill(J.docs.length, pJ.docs.length / dayDiv, false), sub: '저장완료 ' + saved + (wr ? ' · <span style="color:' + V.warn + ';font-weight:700">작성중 ' + wr + '</span>' : ''), spark: sp(function (d) { return J.byDay[d] || 0; }, V.accent) },
      { label: '대두 사용량', color: PC.juice, value: nv(PJ.use, f1(PJ.use) + u('kg')), badge: PJ.use ? dpill(PJ.use, (pPJ.use || 0) / dayDiv, false) : '', sub: PJ.raw ? '원액 ' + f1(PJ.raw) + 'kg' : '&nbsp;', spark: sp(function (d) { return (PR.juice[d] || {}).use; }, PC.juice) },
      { label: '배합 배치', color: PC.mix, value: nv(PM.nb, f1(PM.nb) + u('배치')), badge: PM.nb ? dpill(PM.nb, (pPM.nb || 0) / dayDiv, false) : '', sub: PM.b1 != null ? '평균 Brix ' + f1(PM.b1, 2) : '&nbsp;', spark: sp(function (d) { return (PR.mix[d] || {}).nb; }, PC.mix) },
      { label: '포장 생산량', color: PC.pack, value: nv(PK.ea, PK.ea >= 10000 ? f1(PK.ea / 1e4, 1) + u('만 개') : f1(PK.ea) + u('개')), badge: PK.ea ? dpill(PK.ea, (pPK.ea || 0) / dayDiv, false) : '', sub: PK.waste != null ? '불량팩 ' + f1(PK.waste) + '개' : (PK.rate != null ? 'B호기 가동률 ' + f1(PK.rate, 1) + '%' : '&nbsp;'), spark: sp(function (d) { return (PR.pack[d] || {}).ea; }, PC.pack) },
      { label: '투입 인시', color: '#7C3AED', value: nv(L.total.pd ? L.total.h : null, f1(L.total.h, L.total.h >= 100 ? 0 : 1) + u('h')), badge: L.total.h ? dpill(L.total.h, pL.total.h / dayDiv, true) : '', sub: L.total.h ? 'OT ' + f1(L.total.ot, 1) + 'h · 심야 ' + f1(L.total.ng, 1) + 'h' : '근무일보 없음', spark: sp(function (d) { return (L.byDay[d] || {}).h; }, '#7C3AED') }
    ]);

    /* ── 02 공정 흐름 ── */
    var stage = function (c, nm, rows) { return '<td valign="top" width="23%" style="background:' + V.card + ';border:1px solid ' + V.line + ';border-top:3px solid ' + c + ';border-radius:12px;padding:11px 12px;font-family:' + FONT + '"><div style="font-size:12px;font-weight:800;color:' + c + '">' + nm + '</div>' + rows.map(function (r) { return '<div style="margin-top:6px"><div style="font-size:10.5px;color:' + V.mute + '">' + r[0] + '</div><div style="font-size:14.5px;font-weight:800;color:' + V.ink + ';white-space:nowrap">' + r[1] + '</div></div>'; }).join('') + '</td>'; };
    var arrow = '<td width="2.6%" align="center" valign="middle" style="color:#B8C1D1;font-size:14px;font-weight:800">›</td>';
    var stopN = J.stops.length;
    var vu = function (x, un, dg) { return x == null || isNaN(x) ? '<span style="color:#9AA4B5">—</span>' : f1(x, dg) + un; };
    h += S('공정 흐름', '착즙 → 배합 → 멸균 → 포장 · 저장된 일지 기준');
    h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-collapse:separate;border-spacing:0"><tr>' +
      stage(PC.juice, '❖ 착즙', [['대두 사용량', vu(PJ.use, ' kg')], ['원액 생산', vu(PJ.raw, ' kg')], ['분리액 생산 · 중단', PJ.prodH == null && PJ.stopH == null ? vu(null) : f1(PJ.prodH) + 'h · ' + f1(PJ.stopH) + 'h']]) + arrow +
      stage(PC.mix, '⚗ 배합', [['배치', vu(PM.nb, ' 배치')], ['평균 최종 Brix', vu(PM.b1, '', 2)], ['점검 X', (PM.x || 0) + '건']]) + arrow +
      stage(PC.ster, '♨ 멸균', [['적산량', fmtQty(sterQ)], ['가동 시간', f1(sterRun, 1) + 'h'], ['정지 기록', stopN + '건']]) + arrow +
      stage(PC.pack, '▣ 포장', [['생산량', vu(PK.ea, ' 개')], ['불량팩', vu(PK.waste, ' 개')], ['점검 불량(X)', (PK.bad || 0) + '건']]) + '</tr></table>';

    /* ── 03 확인 필요 사항 ── */
    var act = [];
    (M.big || []).slice(0, 3).forEach(function (r) { act.push([2, '<b>' + esc(r.div) + ' ' + esc((r.team || '') + ' ' + (r.hogi || '')) + '</b> ' + hrs(r.min) + ' 지연 — ' + esc(clip(r.reason || '-', 30)) + ' <span style="color:' + V.mute + '">(' + md(r.d) + ')</span>']); });
    J.devs.slice(0, 3).forEach(function (x) { act.push([2, '<b>' + esc(clip(x.form, 16)) + '</b> ' + esc(clip(x.what, 26)) + ' 값 <b style="color:' + V.bad + '">' + esc(x.val) + '</b> (기준 ' + esc(x.spec) + ') <span style="color:' + V.mute + '">' + md(x.d) + '</span>']); });
    status.filter(function (x) { return x.lv; }).forEach(function (x) { act.push([x.lv, '<b>' + x.dv + '</b> 지연 ' + hrs(x.s.min) + ' — ' + unit + ' 크게 늘었습니다']); });
    if (PK.bad) act.push([1, '포장 점검 불량(X) <b>' + PK.bad + '건</b>']);
    if (wr) act.push([1, '작성중(서명 · 인쇄 전) 일지 <b>' + wr + '건</b> — 마무리 확인']);
    var otp = Object.keys(L.people).map(function (k) { return L.people[k]; }).sort(function (a, b) { return b.ot - a.ot; })[0];
    if (otp && otp.ot >= (kind === 'daily' ? 4 : kind === 'weekly' ? 10 : 30)) act.push([1, 'OT 집중: <b>' + esc(otp.n) + '</b> (' + otp.dv + ') ' + f1(otp.ot, 1) + '시간']);
    act.sort(function (a, b) { return b[0] - a[0]; });
    h += S('확인 필요 사항', act.length ? act.length + '건' : '');
    h += box('', act.length ? act.slice(0, 8).map(function (a) { return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td width="22" valign="top" style="padding:6px 0"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + (a[0] === 2 ? V.bad : V.warn) + ';margin-top:5px"></span></td><td style="padding:6px 0;font-size:13px;line-height:1.6;border-bottom:1px solid #F0F2F6;font-family:' + FONT + '">' + a[1] + '</td></tr></table>'; }).join('')
      : '<div style="font-size:13.5px;color:' + V.good + ';font-weight:700">✓ 특별히 확인할 사항이 없습니다</div>');

    /* ── 04 생산 지연 분석 ── */
    h += S('생산 지연 분석', '총 ' + hrs(M.delayMin) + (many ? ' · 하루 평균 ' + hrs(M.delayMin / nd) : ''));
    if (many) { var ser = M.daily.map(function (o) { var w = dowN(o.d); return Object.assign({ lab: kind === 'weekly' ? md(o.d) + ' ' + dowOf(o.d) : String(+o.d.slice(8)), we: w === 0 || w === 6 }, o); });
      h += box('날짜별 지연 (부서별)', vbars(ser, DIVS, DIVS.map(function (d) { return DC[d]; }), { h: kind === 'weekly' ? 110 : 90, top: function (t) { return hshort(t); }, legend: DIVS.map(function (d) { return d + ' (' + DIVSUB[d] + ')'; }) })); }
    if (kind === 'monthly') h += box('지연 달력', heat(M.days, dmin, function (d) { return hshort(dmin(d)); }));
    var share = DIVS.map(function (dv) { return [dv, M.div[dv].min, DC[dv], hrs(M.div[dv].min)]; });
    var reasonRows = (function () { var tot = M.delayMin || 1, cum = 0; return M.reasons.map(function (r) { cum += r[1]; return [r[0], r[1], hshort(r[1]) + ' · ' + r[2] + '건 · <span style="color:#A9853F">누적 ' + pct(cum, tot) + '%</span>', r === M.reasons[0] ? V.bad : V.navy2]; }); })();
    h += two(box('지연 원인 TOP', hbars(reasonRows, { rank: 1, lw: 36, vw: 36 }), '파레토'), box('부서 · 호기별', stack(share) + '<div style="height:12px"></div>' + hbars(M.hogi.map(function (r) { return [r[0], r[1], hshort(r[1]) + ' · ' + r[2] + '건', '#12A39A']; }), { lw: 34, vw: 26 })));
    if (many && M.products.length) h += two(box('지연이 많았던 제품', hbars(M.products.map(function (r) { return [r[0], r[1], hrs(r[1]), '#7B5CD6']; }), { lw: 40 })), box('시간대별 지연', vbars(M.hours.map(function (x) { return { lab: x.h + '시', v: x.min }; }), ['v'], [C.amber], { h: 70, top: function (t) { return hshort(t); } })));
    h += box((kind === 'daily' ? '2시간' : '3시간') + ' 이상 지연', table(['날짜', '부서 · 호기', '제품', '사유', '시간'], M.big.map(function (r) {
      return [md(r.d), esc(r.div) + '<br><span style="color:' + V.mute + '">' + esc((r.team || '') + ' ' + (r.hogi || '')) + '</span>', esc(clip(r.product || '-', 18)), esc(clip(r.reason || '-', 26)) + (r.detail ? '<div style="color:' + V.mute + ';font-size:11.5px;margin-top:2px">' + esc(clip(r.detail, 60)) + '</div>' : ''), '<b style="color:' + V.bad + '">' + hrs(r.min) + '</b>']; }), { empty: '해당 지연 없음 👍' }));

    /* ── 05 공정별 생산 실적 ── */
    var hasM = !!(PM.nb || PM.q || PM.x), hasJ = !!(PJ.use || PJ.raw || PJ.prodH || PJ.by || PJ.sug), hasK = !!(PK.ea || PK.rate || PK.stopN || PK.bad), sk = Object.keys(J.ster);
    if (hasM || hasJ || hasK || sk.length) {
      var per = function (x, dg) { return many && x != null ? ' <span style="color:' + V.mute + '">(일 평균 ' + f1(x, dg) + ')</span>' : ''; };
      h += S('공정별 생산 실적', '저장된 일지 기준');
      var parts = [];
      if (hasJ) parts.push(box('❖ 착즙', table(['항목', many ? '합계 · 평균' : '값'], [['대두 사용량', '<b>' + f1(PJ.use) + '</b> kg' + per(PJ.days ? PJ.use / PJ.days : null)], ['부산물', f1(PJ.by) + ' kg' + (PJ.use && PJ.by != null ? ' (' + f1(PJ.by / PJ.use * 100, 1) + '%)' : '')], ['분리액 생산 · 중단', f1(PJ.prodH) + 'h · ' + f1(PJ.stopH) + 'h'], ['원액 생산', f1(PJ.raw) + ' kg'], ['원액 T.S 평균', f1(PJ.ts, 2) + ' <span style="color:' + V.mute + '">(10±0.2)</span>'], ['설탕 투입', f1(PJ.sug) + ' kg']]), '', PC.juice));
      if (hasM) parts.push(box('⚗ 배합', table(['항목', many ? '합계 · 평균' : '값'], [['배치', '<b>' + f1(PM.nb) + '</b> 배치' + per(PM.days ? PM.nb / PM.days : null, 1)], ['호기별 생산량', f1(PM.q, 1) + ' Batch'], ['평균 최종 Brix', f1(PM.b1, 2)], ['점검 X', PM.x ? '<b style="color:' + V.bad + '">' + PM.x + '건</b>' : '0건']]), '', PC.mix));
      if (sk.length) { var qmax = Math.max.apply(null, sk.map(function (k) { return J.ster[k].qty; })) || 1;
        parts.push(box('♨ 멸균 호기별', table(['호기', '가동', '적산량', '배치'], sk.map(function (k) { var s = J.ster[k]; return ['<b>' + esc(k) + '</b>', f1(s.run, 1) + 'h', '<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td width="' + Math.max(3, Math.round(s.qty / qmax * 100)) + '%" style="background:' + PC.ster + ';height:9px;border-radius:5px;font-size:0">&nbsp;</td><td style="padding-left:6px;white-space:nowrap;font-size:12px">' + fmtQty(s.qty) + '</td></tr></table>', s.batch || '-']; })), '', PC.ster)); }
      if (hasK) { var hoBy = function (o, uu) { var ks = Object.keys(o || {}).sort(); return ks.length ? ' <span style="color:' + V.mute + '">(' + ks.map(function (x) { return (x === 'DE' || x === '?' ? x : x + '호기') + ' ' + f1(o[x]) + (uu || ''); }).join(' · ') + ')</span>' : ''; };
        parts.push(box('▣ 포장 (A~F호기)', table(['항목', many ? '합계 · 평균' : '값'], [['생산량', '<b>' + f1(PK.ea) + '</b> 개' + (PK.box != null ? ' · ' + f1(PK.box) + ' Box' : '') + per(PK.days ? PK.ea / PK.days : null)]].concat(PK.ln && PK.ln.length ? [['호기별', PK.ln.map(function (x) { return x[0] + ' ' + f1(x[1]); }).join(' · ')]] : []).concat(PK.waste != null ? [['밀봉 불량팩', '<b>' + f1(PK.waste) + '</b> 개' + hoBy(PK.wasteBy)]] : []).concat([['B호기 가동률', PK.rate != null ? f1(PK.rate, 1) + '%' : '-'], ['정지', f1(PK.stopN) + '회' + (PK.stopMin != null ? ' · ' + f1(PK.stopMin) + '분' : '')], ['점검 불량(X)', PK.bad ? '<b style="color:' + V.bad + '">' + PK.bad + '건</b>' + hoBy(PK.badBy, '건') : '0건']])), '', PC.pack)); }
      for (var pi = 0; pi < parts.length; pi += 2) h += parts[pi + 1] ? two(parts[pi], parts[pi + 1]) : parts[pi];
      if (J.stops.length) h += box('멸균 정지 기록 ' + J.stops.length + '건', table(['날짜', '호기', '정지 → 재가동', '사유'], J.stops.slice(0, 10).map(function (s) { return [md(s.d), esc(s.hogi), esc(s.start) + ' → ' + esc(s.end) + (s.min ? ' <b>(' + hrs(s.min) + ')</b>' : ''), esc(clip(s.why, 40))]; })));
      if (many) { var dd = M.days.map(function (d) { var w = dowN(d), mx = PR.mix[d] || {}, jx = PR.juice[d] || {}, px = PR.pack[d] || {}; return { lab: kind === 'weekly' ? md(d) + ' ' + dowOf(d) : String(+d.slice(8)), we: w === 0 || w === 6, nb: mx.nb || 0, use: jx.use ? Math.round(jx.use / 100) / 10 : 0, ea: px.ea ? Math.round(px.ea / 100) / 10 : 0 }; });
        var cs = []; if (hasJ) cs.push(box('대두 사용량 (톤)', vbars(dd, ['use'], [PC.juice], { h: 80, top: function (t) { return t || ''; } }))); if (hasM) cs.push(box('배합 배치', vbars(dd, ['nb'], [PC.mix], { h: 80, top: function (t) { return t || ''; } }))); if (hasK) cs.push(box('포장 생산량 (천 개)', vbars(dd, ['ea'], [PC.pack], { h: 80, top: function (t) { return t || ''; } })));
        for (var ci = 0; ci < cs.length; ci += 2) h += cs[ci + 1] ? two(cs[ci], cs[ci + 1]) : cs[ci]; }
    }

    /* ── 06 품질 · HACCP ── */
    h += S('품질 · HACCP', J.ccpChecks ? '측정 ' + J.ccpChecks + '회 · 이탈률 ' + (Math.round(devN / J.ccpChecks * 1000) / 10) + '%' : '');
    var dg = topBy(J.devs, function (x) { return x.form; }, null, 6);
    h += box('', (devN ? hbars(dg.map(function (r) { return [r[0], r[1], r[1] + '건', V.bad]; }), { lw: 40 }) + '<div style="height:10px"></div>' : '') +
      table(['날짜', '일지', '항목', '값', '기준'], J.devs.slice(0, kind === 'monthly' ? 14 : 10).map(function (x) { return [md(x.d), esc(clip(x.form, 18)), esc(clip(x.what, 34)), '<b style="color:' + V.bad + '">' + esc(x.val) + '</b>', esc(x.spec)]; }), { empty: (J.ccpChecks ? 'HACCP 측정 ' + J.ccpChecks + '회 — ' : '') + '기준 이탈 없음 ✅' }));

    /* ── 07 인력 · 근태 ── */
    if (L.total.pd) {
      h += S('인력 · 근태', '근무일보 기준 · 근무시간 칸(OT 포함)' + (L.wage ? ' · 노무비 단가 ' + f1(L.wage) + '원/h' : ''));
      var dvs = DIVS.filter(function (dv) { return L.byDiv[dv]; });
      h += box('', table(['부서', '인원', '연인원', '투입 인시', 'OT', '심야', '1인·일', '추정 노무비'], dvs.map(function (dv) { var o = L.byDiv[dv], po = (pL.byDiv[dv] || {}).h; return [chip(dv, '#F1F3F8', DC[dv] || V.mute), o.n + '명', o.pd + '명', '<b>' + f1(o.h, 1) + 'h</b>' + (po ? '<br>' + dpill(o.h, po / dayDiv, true) : ''), f1(o.ot, 1) + 'h', f1(o.ng, 1) + 'h', f1(o.h / o.pd, 1) + 'h', o.cost != null ? '<b>' + won(o.cost) + '원</b>' : '-']; })
        .concat([['<b>합계</b>', L.total.n + '명', L.total.pd + '명', '<b>' + f1(L.total.h, 1) + 'h</b>', '<b>' + f1(L.total.ot, 1) + 'h</b>', f1(L.total.ng, 1) + 'h', f1(L.total.h / L.total.pd, 1) + 'h', L.total.cost != null ? '<b>' + won(L.total.cost) + '원</b>' : '단가 미입력']])));
      if (many) { var ls = M.days.map(function (d) { var w = dowN(d), y = L.byDay[d] || { div: {} }, o = { lab: kind === 'weekly' ? md(d) + ' ' + dowOf(d) : String(+d.slice(8)), we: w === 0 || w === 6 }; DIVS.forEach(function (dv) { o[dv] = Math.round(y.div[dv] || 0); }); return o; });
        h += box('날짜별 투입 인시 (부서별)', vbars(ls, DIVS, DIVS.map(function (d) { return DC[d]; }), { h: 90, top: function (t) { return t ? Math.round(t) : ''; }, legend: DIVS })); }
      var top = Object.keys(L.people).map(function (k) { return L.people[k]; }).filter(function (p) { return p.ot > 0; }).sort(function (a, b) { return b.ot - a.ot; }).slice(0, 8);
      var ml = L.total.ml, mlt = ml[0] + ml[1] + ml[2] + ml[3];
      h += two(box('OT 상위', top.length ? hbars(top.map(function (p) { return [p.n + ' · ' + p.dv.replace('팀', ''), p.ot, f1(p.ot, 1) + 'h · ' + p.d + '일', '#7C3AED']; }), { lw: 42, vw: 26 }) : '<div style="font-size:13px;color:' + V.mute + '">OT 기록 없음</div>'),
        box('식수 집계', mlt ? stack([['조식', ml[0], '#F2B84B', ml[0] + '식'], ['중식', ml[1], '#2F5BD8', ml[1] + '식'], ['석식', ml[2], '#7B5CD6', ml[2] + '식'], ['야식', ml[3], '#334155', ml[3] + '식']]) + '<div style="font-size:12px;color:' + V.mute + ';margin-top:8px">근무일보 조 · 중 · 석 · 야식 칸 표시 기준 · 합계 <b style="color:' + V.ink + '">' + mlt + '식</b></div>' : '<div style="font-size:13px;color:' + V.mute + '">식사 표시 없음</div>'));
    }

    /* ── 08 설비 · 정비 ── */
    if (M.maints.length) {
      h += S('설비 · 정비', M.maintN + '건');
      h += two(box('정비 종류', hbars(M.mtype.map(function (r) { return [r[0], r[1], r[1] + '건', '#12A39A']; }), { lw: 40 })), box('정비가 잦은 설비', hbars(M.massets.map(function (r) { return [r[0], r[1], r[1] + '건', '#5B7BB7']; }), { lw: 46, clip: 20 })));
      if (kind === 'daily') h += box('정비 내역', table(['설비', '내용', '종류', '담당'], M.maints.slice(0, 12).map(function (r) { return [esc(r.asset || '-'), esc(clip(r.content || '-', 40)), esc(r.mtype || '-'), esc(r.person || '')]; })));
    }

    /* ── 09 일지 작성 현황 ── */
    var fr = Object.keys(J.byForm).map(function (k) { return J.byForm[k]; }).sort(function (a, b) { return TEAMS.indexOf(a.team) - TEAMS.indexOf(b.team) || b.n - a.n; });
    var tparts = TEAMS.filter(function (t) { return J.byTeam[t]; }).map(function (t) { return [t, J.byTeam[t], TC[t], J.byTeam[t] + '건']; });
    h += S('일지 작성 현황', '저장완료 ' + saved + '건' + (wr ? ' · 작성중 ' + wr + '건' : ''));
    h += box('', (tparts.length ? stack(tparts) + '<div style="height:12px"></div>' : '') + (many ? matrix(fr.slice(0, kind === 'monthly' ? 18 : 22), M.days) : table(['일지', '팀', '건수'], fr.slice(0, 16).map(function (r) { return [esc(r.name), chip(r.team, '#F1F3F8', TC[r.team] || V.mute), '<b>' + r.n + '</b>']; }), { empty: '저장된 일지 없음' })), many ? '칸이 채워진 날 = 그 일지를 작성한 날' : '');

    /* ── 10 KPI (월간) ── */
    var KP = M.K || [];
    if (kind === 'monthly' && KP.some(function (k) { return !k.none; })) {
      h += S('KPI 현황', '팀장이 올린 KPI 실적 엑셀 기준');
      h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-collapse:separate;border-spacing:0"><tr>' + KP.map(function (k, i) {
        return (i ? '<td style="width:2%"></td>' : '') + '<td width="32%" valign="top" style="background:' + V.card + ';border:1px solid ' + V.line + ';border-radius:12px;padding:12px 14px;font-family:' + FONT + '"><div style="font-size:12px;font-weight:800;color:' + V.sub + '">' + esc(k.label) + '</div>' +
          (k.none ? '<div style="font-size:13px;color:' + V.mute + ';margin-top:8px">KPI 실적 엑셀 대기</div>' : '<div style="font-size:26px;font-weight:800;margin-top:4px">' + f1(k.score, 1) + '<span style="font-size:12px;color:' + V.mute + '"> / 100</span></div><div style="height:6px;background:#EEF1F6;border-radius:4px;margin-top:6px"><div style="width:' + Math.max(2, Math.min(100, Math.round(k.score))) + '%;height:6px;background:' + V.accent + ';border-radius:4px;font-size:0">&nbsp;</div></div><div style="font-size:11.5px;color:' + V.sub + ';margin-top:7px">Lev.1 ' + k.lv1 + ' / ' + k.n + ' · 관리 필요 <b style="color:' + (k.warn.length ? V.bad : V.good) + '">' + k.warn.length + '</b></div>') + '</td>'; }).join('') + '</tr></table>';
      var wl = []; KP.forEach(function (k) { (k.warn || []).forEach(function (x) { wl.push([k.k, x]); }); });
      if (wl.length) h += box('관리 필요 KPI 항목 (Lev.4~5)', table(['팀', '항목', '점수'], wl.map(function (x) { return [chip(x[0], '#F1F3F8', V.sub), esc(x[1].name), '<b style="color:' + V.bad + '">' + f1(x[1].score, 1) + '</b> / ' + f1(x[1].w, 0)]; })));
    }

    /* ── 현장 메모 ── */
    if (J.notes.length) {
      h += S('현장 메모 · 특이사항', J.notes.length + '건');
      h += box('', J.notes.slice(0, kind === 'daily' ? 10 : 14).map(function (n) { return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:9px"><tr><td width="3" style="background:' + (TC[n.team] || V.mute) + ';border-radius:3px;font-size:0">&nbsp;</td><td style="padding:2px 10px;font-family:' + FONT + '"><div style="font-size:11px;color:' + V.mute + '">' + md(n.d) + ' · ' + esc(n.form) + ' · ' + esc(n.what) + '</div><div style="font-size:13px;margin-top:2px;line-height:1.55">' + esc(n.text) + '</div></td></tr></table>'; }).join(''), J.notes.length > 14 ? '외 ' + (J.notes.length - 14) + '건' : '');
    }

    /* ── 다음 생산계획 ── */
    var pb = groupBy(M.plan, 'colLabel'), pl = Object.keys(pb).sort(), FL = 'ABCDEF';
    h += S((kind === 'daily' ? md(M.planFrom) + '(' + dowOf(M.planFrom) + ') ' : kind === 'weekly' ? '다음 주 ' : '다음 달 ') + '생산계획', M.plan.length + '건 · ' + pl.length + '개 설비');
    h += box('', pl.length ? (kind === 'daily' ? table(['설비', '품목', '배치', '충전', '시간'], [].concat.apply([], pl.map(function (l) { return pb[l].map(function (c, i) { return [i ? '' : '<b>' + esc(l) + '</b>', esc(c.code || '') + ' ' + esc(c.name || ''), c.batch ? esc(c.batch) : '-', c.filler ? pill(FL[(+c.filler || 1) - 1] + '호기', '#EAF1FE', V.accent) : '-', esc(c.time || '')]; }); })))
      : hbars(pl.map(function (l) { return [l, pb[l].length, pb[l].length + '건', '#2E9E6A']; }), { lw: 30 })) : '<div style="font-size:13px;color:' + V.mute + '">등록된 생산계획 없음</div>');

    h += '<div style="font-size:11px;color:' + V.mute + ';margin-top:20px;text-align:center;line-height:1.8;font-family:' + FONT + '">이 보고서는 업무포털의 일지 · 근무일보 · 지연 · 정비 · 생산계획 · KPI 자료로 자동 생성되었습니다.<br>노무비는 입력된 시간당 단가로 계산한 추정치입니다.' + (opts.portalUrl ? '<br><a href="' + esc(opts.portalUrl) + '#/reports?t=' + kind + '&amp;k=' + esc(P.key) + '" style="color:' + V.accent + ';font-weight:800;text-decoration:none">포털에서 자세히 보기 →</a>' : '') + '</div></div>';
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
    if (M.L && M.L.total.pd) { t.push('근무일보 투입 인시 ' + Math.round(M.L.total.h) + '시간 (연인원 ' + M.L.total.pd + '명, OT ' + Math.round(M.L.total.ot * 10) / 10 + 'h, 심야 ' + Math.round(M.L.total.ng * 10) / 10 + 'h' + (M.L.total.cost != null ? ', 추정 노무비 ' + Math.round(M.L.total.cost / 10000) + '만원' : '') + ')'); DIVS.forEach(function (dv) { var o = M.L.byDiv[dv]; if (o) t.push('  [' + dv + '] 인시 ' + Math.round(o.h) + 'h, OT ' + Math.round(o.ot * 10) / 10 + 'h'); }); }
    (M.K || []).forEach(function (k) { if (!k.none) t.push('KPI ' + k.label + ': ' + Math.round(k.score * 10) / 10 + '점, 관리 필요 ' + k.warn.length + '항목'); });
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

  return { insights: insights, mergeInsights: mergeInsights, AI_INSIGHT: AI_INSIGHT, build: build, report: report, period: period, records: records, analyze: analyze, introspect: introspect, specOf: specOf, teamOf: teamOf,
    kstDate: kstDate, addDays: addDays, isoWeek: isoWeek, AI: AI, AI_SYSTEM: AI_SYSTEM, DIVS: DIVS };
});
