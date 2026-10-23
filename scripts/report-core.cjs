/* 일일 보고서 생성 공통 로직 — 포털(브라우저)과 GitHub Actions(Node)에서 똑같이 사용
   입력: 포털 데이터(app_state.data) + 노션 이전 데이터(window.__YUM_NOTION_FINAL__)
   출력: { date, title, summary(알림용 한 줄), stats, html(메일·포털 표시용), text } */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.YumReportCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var DIVS = ['가공2팀', '가공1팀', '포장팀'];
  var DOW = '일월화수목금토';

  function kstDate(offsetDays, now) {
    var t = (now ? new Date(now) : new Date()).getTime() + 9 * 3600 * 1000 + (offsetDays || 0) * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  }
  function addDays(d, n) { var t = new Date(d + 'T00:00:00Z').getTime() + n * 86400000; return new Date(t).toISOString().slice(0, 10); }
  function dowOf(d) { return DOW[new Date(d + 'T00:00:00Z').getUTCDay()]; }
  function mdLite(t) { return esc(String(t || '').trim()).replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/^\s*[-*•]\s+/gm, '• ').replace(/\n/g, '<br>'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function hrs(m) { m = +m || 0; if (m < 60) return m + '분'; var h = Math.floor(m / 60), r = m % 60; return h + '시간' + (r ? ' ' + r + '분' : ''); }
  function toMin(t) { if (!t) return null; var p = String(t).split(':'); if (p.length < 2) return null; return (+p[0]) * 60 + (+p[1]); }
  function rmins(s, e) { var a = toMin(s), b = toMin(e); if (a == null || b == null) return null; if (b < a) b += 1440; return b - a; }

  /* 노션 이전 기록 + 포털 작성 기록 → 같은 형식 */
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

  function sum(list) { return list.reduce(function (a, r) { return a + (+r.min || 0); }, 0); }
  function topBy(list, keyf, valf, n) {
    var g = {};
    list.forEach(function (r) { var k = keyf(r); if (!k) return; g[k] = g[k] || [0, 0]; g[k][0] += valf ? valf(r) : 1; g[k][1]++; });
    return Object.keys(g).map(function (k) { return [k, g[k][0], g[k][1]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, n || 5);
  }

  /* opts: { date: 'YYYY-MM-DD'(보고 대상일, 기본 어제), sections: {...}, now } */
  function build(data, NF, opts) {
    opts = opts || {};
    var D = opts.date || kstDate(-1, opts.now);
    var S = Object.assign({ delay: true, maint: true, docs: true, plan: true, big: true }, opts.sections || {});
    var all = records(data, NF);
    var day = all.filter(function (r) { return r.d === D; });
    var w0 = addDays(D, -7), week = all.filter(function (r) { return r.d >= w0 && r.d < D; });
    var stats = { date: D, divs: {} };
    DIVS.forEach(function (dv) {
      var dl = day.filter(function (r) { return r.div === dv && r.kind === 'delay'; });
      var ml = day.filter(function (r) { return r.div === dv && r.kind === 'maint'; });
      var wl = week.filter(function (r) { return r.div === dv && r.kind === 'delay'; });
      stats.divs[dv] = {
        delayN: dl.length, delayMin: sum(dl), maintN: ml.length,
        avgN: Math.round(wl.length / 7 * 10) / 10, avgMin: Math.round(sum(wl) / 7),
        reasons: topBy(dl, function (r) { return r.reason; }, function (r) { return +r.min || 0; }, 3),
        big: dl.filter(function (r) { return (+r.min || 0) >= 120; }).sort(function (a, b) { return (b.min || 0) - (a.min || 0); }).slice(0, 5),
        delays: dl, maints: ml
      };
    });
    var totalN = 0, totalMin = 0, totalM = 0;
    DIVS.forEach(function (dv) { totalN += stats.divs[dv].delayN; totalMin += stats.divs[dv].delayMin; totalM += stats.divs[dv].maintN; });
    stats.totalN = totalN; stats.totalMin = totalMin; stats.totalM = totalM;

    /* 문서 · 결재 */
    var docs = (data && data.docs) || [];
    var forms = {}; ((data && data.forms) || []).forEach(function (f) { forms[f.id] = f; });
    var savedDay = docs.filter(function (d) { return (d.status === 'saved' || d.status === 'completed') && String(d.savedAt || d.updatedAt || d.createdAt || '').slice(0, 10) === D; });
    var pending = docs.filter(function (d) { return d.status === 'pending' || d.status === 'in_progress'; });
    stats.docsSaved = savedDay.length; stats.pending = pending.length;
    stats.docList = savedDay.slice(0, 12).map(function (d) { return (forms[d.formId] || {}).name || d.title || '문서'; });

    /* 오늘(보고 다음날) 생산계획 */
    var T = addDays(D, 1), tl = (+T.slice(5, 7)) + '/' + (+T.slice(8, 10));
    var plan = [];
    Object.keys((data && data.planWeeks) || {}).forEach(function (k) {
      var w = data.planWeeks[k];
      (w.cells || []).forEach(function (c) { if (c.rowLabel === tl) plan.push(c); });
    });
    var planBy = {}; plan.forEach(function (c) { (planBy[c.colLabel] = planBy[c.colLabel] || []).push(c); });
    stats.planDate = T; stats.plan = planBy;

    var title = '📋 ' + D.slice(5).replace('-', '/') + '(' + dowOf(D) + ') 일일 보고';
    var summary = '지연 ' + totalN + '건' + (totalMin ? '(총 ' + hrs(totalMin) + ')' : '') + ' · 정비 ' + totalM + '건' +
      (stats.pending ? ' · 결재 대기 ' + stats.pending + '건' : '');
    var topAll = topBy(day.filter(function (r) { return r.kind === 'delay'; }), function (r) { return r.reason; }, function (r) { return +r.min || 0; }, 1)[0];
    if (topAll) summary += ' · 최다 사유: ' + topAll[0];

    /* ---------- HTML (메일 호환: 인라인 스타일) ---------- */
    var C = { navy: '#13254B', gold: '#C8A15A', mute: '#5A6680', line: '#E6E9F1', red: '#B23A3A', bg: '#F5F6FA' };
    var h = '';
    h += '<div style="font-family:\'Malgun Gothic\',\'Apple SD Gothic Neo\',sans-serif;color:#111A2E;max-width:720px;margin:0 auto">';
    h += '<div style="background:linear-gradient(110deg,#0A142B,#24448C);background-color:' + C.navy + ';color:#fff;border-radius:14px;padding:20px 22px">' +
      '<div style="font-size:12px;letter-spacing:.12em;color:#E3C68B;font-weight:700">연세우유 상온제품생산부문 · 일일 보고</div>' +
      '<div style="font-size:22px;font-weight:800;margin-top:6px">' + esc(D) + ' (' + dowOf(D) + ')</div>' +
      '<div style="font-size:13.5px;margin-top:6px;opacity:.9">' + esc(summary) + '</div></div>';
    if (opts.ai) h += '<div style="margin-top:14px;border:1px solid ' + C.line + ';border-left:4px solid ' + C.gold + ';border-radius:12px;padding:14px 16px;background:#FFFDF8"><div style="font-size:12px;font-weight:800;color:#A9853F;margin-bottom:6px">✦ AI 요약</div><div style="font-size:14px;line-height:1.75">' + mdLite(opts.ai) + '</div></div>';
    function sec(t, body) { return '<div style="margin-top:14px;border:1px solid ' + C.line + ';border-radius:12px;padding:14px 16px;background:#fff"><div style="font-size:15px;font-weight:800;color:' + C.navy + ';margin-bottom:8px">' + t + '</div>' + body + '</div>'; }
    function tbl(head, rows) {
      if (!rows.length) return '<div style="font-size:13px;color:' + C.mute + '">기록 없음</div>';
      return '<table style="width:100%;border-collapse:collapse;font-size:13px"><tr>' + head.map(function (x) { return '<th style="text-align:left;background:#F2F4F9;padding:6px 8px;border-bottom:1px solid ' + C.line + '">' + x + '</th>'; }).join('') + '</tr>' +
        rows.map(function (r) { return '<tr>' + r.map(function (x) { return '<td style="padding:6px 8px;border-bottom:1px solid #EEF1F5;vertical-align:top">' + x + '</td>'; }).join('') + '</tr>'; }).join('') + '</table>';
    }
    if (S.delay) {
      h += sec('⏱ 부서별 생산 지연', tbl(['부서', '지연', '총 시간', '최근 7일 평균', '주요 사유(시간)'], DIVS.map(function (dv) {
        var s = stats.divs[dv], up = s.delayMin > s.avgMin * 1.3 && s.delayMin > 30;
        return ['<b>' + dv + '</b>', s.delayN + '건', '<span style="' + (up ? 'color:' + C.red + ';font-weight:800' : '') + '">' + hrs(s.delayMin) + (up ? ' ▲' : '') + '</span>', s.avgN + '건 · ' + hrs(s.avgMin), s.reasons.map(function (x) { return esc(x[0]) + ' ' + hrs(x[1]); }).join('<br>') || '-'];
      })));
    }
    if (S.big) {
      var bigs = []; DIVS.forEach(function (dv) { stats.divs[dv].big.forEach(function (r) { bigs.push([dv, esc(r.hogi || '-'), esc(r.product || '-'), esc(r.reason || '-'), '<b style="color:' + C.red + '">' + hrs(r.min) + '</b>', esc(r.detail || '')]); }); });
      h += sec('⚠ 2시간 이상 지연', tbl(['부서', '호기', '제품', '사유', '시간', '기타'], bigs));
    }
    if (S.maint) {
      var ms = []; DIVS.forEach(function (dv) { stats.divs[dv].maints.forEach(function (r) { ms.push([dv, esc(r.asset || '-'), esc(r.content || '-'), esc(r.mtype || '-'), esc(r.person || '')]); }); });
      h += sec('🔧 정비', tbl(['부서', '설비', '내용', '종류', '담당'], ms));
    }
    if (S.docs) {
      h += sec('📝 일지 · 결재', '<div style="font-size:13.5px">저장된 일지 <b>' + stats.docsSaved + '건</b> · 결재 대기 <b>' + stats.pending + '건</b></div>' +
        (stats.docList.length ? '<div style="font-size:12.5px;color:' + C.mute + ';margin-top:6px">' + stats.docList.map(esc).join(' · ') + '</div>' : ''));
    }
    if (S.plan) {
      var lines = Object.keys(planBy).sort();
      h += sec('🏭 ' + T.slice(5).replace('-', '/') + '(' + dowOf(T) + ') 생산계획', lines.length ? tbl(['설비', '품목'], lines.map(function (l) { return [esc(l), planBy[l].map(function (c) { return esc(c.code) + (c.batch ? ' &lt;' + esc(c.batch) + '&gt;' : '') + ' ' + esc(c.name || ''); }).join('<br>')]; })) : '<div style="font-size:13px;color:' + C.mute + '">등록된 생산계획 없음</div>');
    }
    h += '<div style="font-size:11.5px;color:' + C.mute + ';margin-top:14px;text-align:center">이 보고서는 업무포털 데이터로 자동 생성되었습니다.' + (opts.portalUrl ? ' <a href="' + esc(opts.portalUrl) + '#/reports" style="color:#2F5BD3">포털에서 보기</a>' : '') + '</div></div>';

    /* AI에 넘길 요약 텍스트 */
    var txt = [];
    txt.push('보고 대상일: ' + D + ' (' + dowOf(D) + ')');
    DIVS.forEach(function (dv) {
      var s = stats.divs[dv];
      txt.push('[' + dv + '] 지연 ' + s.delayN + '건, 총 ' + s.delayMin + '분 (최근 7일 하루 평균 ' + s.avgN + '건/' + s.avgMin + '분), 정비 ' + s.maintN + '건');
      s.delays.forEach(function (r) { txt.push('  - 지연: ' + [r.hogi, r.product, r.reason, r.min != null ? r.min + '분' : '', r.detail].filter(Boolean).join(' / ')); });
      s.maints.forEach(function (r) { txt.push('  - 정비: ' + [r.asset, r.content, r.mtype, r.etc].filter(Boolean).join(' / ')); });
    });
    txt.push('저장된 일지 ' + stats.docsSaved + '건, 결재 대기 ' + stats.pending + '건');
    Object.keys(planBy).forEach(function (l) { txt.push('다음날 계획 ' + l + ': ' + planBy[l].map(function (c) { return c.code + ' ' + (c.name || ''); }).join(', ')); });

    return { date: D, title: title, summary: summary, stats: { date: D, totalN: totalN, totalMin: totalMin, totalM: totalM, docsSaved: stats.docsSaved, pending: stats.pending }, html: h, text: txt.join('\n') };
  }

  var AI_SYSTEM = '당신은 연세우유 상온제품생산부문의 생산관리 보고 담당자입니다. 주어진 하루치 생산 지연·정비·일지 데이터만 근거로, 부서장이 아침에 1분 안에 읽을 수 있는 한국어 요약을 작성하세요. ' +
    '형식: 3~6개의 짧은 글머리표(•). 가장 큰 문제(시간 기준)와 반복되는 원인, 평소 대비 많이 늘어난 부서, 오늘 확인할 점을 우선합니다. 데이터에 없는 내용은 추측하지 말고, 기록이 없으면 "특이사항 없음"이라고 쓰세요.';

  return { build: build, records: records, kstDate: kstDate, addDays: addDays, AI_SYSTEM: AI_SYSTEM, DIVS: DIVS };
});
