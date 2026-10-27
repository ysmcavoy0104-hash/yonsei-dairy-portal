// 업무 보고서 자동 생성 · 메일 · 폰 알림 (GitHub Actions에서 매시간 실행 → 설정한 시각에만 발송)
//   일일: 설정한 요일 · 시각에 전날 보고 / 주간: 매주 월요일 지난주(월~일) / 월간: 매월 1일 지난달
// 필요한 GitHub Secrets (저장소 주인만 등록·수정 가능)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY        포털 데이터 읽기/보고서 저장
//   ANTHROPIC_API_KEY 또는 OPENAI_API_KEY     (선택) AI 요약 — 관리자 본인 계정
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM   메일 발송
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY       폰 알림(웹 푸시)
//   PORTAL_URL                                 포털 주소 (예: https://아이디.github.io/저장소/)
import fs from 'node:fs';
import { createRequire } from 'node:module';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import webpush from 'web-push';

const require = createRequire(import.meta.url);
const Core = require('./report-core.cjs');
// Secrets에 붙여 넣을 때 들어간 앞뒤 공백·줄바꿈·따옴표 제거
const env = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, typeof v === 'string' ? v.trim().replace(/^["']|["']$/g, '') : v]));
if (env.SMTP_HOST) env.SMTP_HOST = env.SMTP_HOST.replace(/^[a-z]+:\/\//i, '').replace(/[\/:].*$/, '');
const FORCE = process.argv.includes('--force') || env.FORCE === 'true';
const DRY = process.argv.includes('--dry-run') || env.DRY_RUN === 'true';

const RUNLOG = [];
function log(...a) { console.log('[daily-report]', ...a); RUNLOG.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 300)); }
function need(k) { if (!env[k]) throw new Error(`GitHub Secret ${k} 이(가) 없습니다.`); return env[k]; }

const SB = need('SUPABASE_URL').replace(/\/$/, '');
const SBKEY = need('SUPABASE_SERVICE_KEY');
const sbHeaders = { apikey: SBKEY, Authorization: `Bearer ${SBKEY}`, 'Content-Type': 'application/json' };

async function readState() {
  const r = await fetch(`${SB}/rest/v1/app_state?id=eq.1&select=data,updated_at`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`Supabase 읽기 실패 ${r.status}: ${await r.text()}`);
  const rows = await r.json();
  if (!rows.length) throw new Error('app_state 데이터가 없습니다.');
  return rows[0].data;
}
// 보고서·발송 기록만 덧붙여 저장 (다른 사람이 쓴 내용은 그대로 두기 위해 저장 직전에 다시 읽음)
// 보고서 본문(html)은 저장하지 않음 — 포털이 같은 데이터로 다시 그려 보여 줌 (서버 용량 · 사용량 절약)
const STORE = { daily: ['dailyReports', 31], weekly: ['weeklyReports', 26], monthly: ['monthlyReports', 24] };
async function saveReport(rep, sentInfo) {
  const data = await readState();
  const [field, keep] = STORE[rep.kind];
  data[field] = data[field] || {};
  data[field][rep.key] = { kind: rep.kind, key: rep.key, date: rep.key, from: rep.from, to: rep.to, label: rep.label, title: rep.title, summary: rep.summary, ai: rep.ai || '', stats: rep.stats, generatedAt: new Date().toISOString(), sent: sentInfo };
  const keys = Object.keys(data[field]).sort();
  while (keys.length > keep) delete data[field][keys.shift()];
  /* 예전 일일 보고서에 남아 있던 본문(html)도 정리 */
  if (data.dailyReports) Object.values(data.dailyReports).forEach((r) => { if (r && r.html) delete r.html; });
  const r = await fetch(`${SB}/rest/v1/app_state?id=eq.1`, { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ data, updated_at: new Date().toISOString() }) });
  if (!r.ok) throw new Error(`Supabase 저장 실패 ${r.status}: ${await r.text()}`);
}

function loadNotionFinal() {
  try {
    const html = fs.readFileSync('index.html', 'utf8');
    const m = html.match(/window\.__YUM_NOTION_FINAL__=(\{[\s\S]*?\});\n<\/script>/);
    if (m) return JSON.parse(m[1].replace(/<\\\//g, '</'));
  } catch (e) { log('노션 이전 데이터 읽기 실패 — 포털 작성 기록만 사용', e.message); }
  return { delay: [], maint: [] };
}

/* 일지 양식(원본 그대로 만든 양식)은 index.html 안에 들어 있음 → 일지 내용 분석에 사용 */
function loadTemplates() {
  try {
    const html = fs.readFileSync('index.html', 'utf8');
    const m = html.match(/var T=(\{"FRM-[\s\S]*?\});\n(?:var NEWF|function)/);
    if (m) return JSON.parse(m[1].replace(/<\\\//g, '</'));
  } catch (e) { log('일지 양식 읽기 실패 — 포털 데이터의 양식 사용', e.message); }
  return null;
}

function textOf(blocks) { return (blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(); }
const FALLBACK_MODELS = /^(claude-opus-5-5|claude-opus-5|claude-fable-5-1|claude-fable-5|claude-sonnet-5-5)$/;

async function aiSummary(cfg, text, kind) {
  if (!cfg.ai) return '';
  const SYS = (Core.AI && Core.AI[kind]) || Core.AI_SYSTEM;
  const prompt = `[${{ daily: '하루치', weekly: '한 주', monthly: '한 달' }[kind] || ''} 데이터]\n${text}\n\n위 데이터로 ${{ daily: '오늘 아침 보고용', weekly: '주간 보고용', monthly: '월간 보고용' }[kind] || ''} 요약을 작성하세요.`;
  try {
    if (env.ANTHROPIC_API_KEY) {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const model = cfg.model || 'claude-opus-5-5';
      const req = { model, max_tokens: 16000, system: SYS, messages: [{ role: 'user', content: prompt }] };
      let res;
      if (FALLBACK_MODELS.test(model)) res = await client.beta.messages.create({ ...req, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
      else res = await client.messages.create(req);
      if (res.stop_reason === 'refusal') { log('AI가 요약을 거절했습니다 — AI 요약 없이 발송'); return ''; }
      return textOf(res.content);
    }
    if (env.OPENAI_API_KEY) {
      const model = cfg.openaiModel || env.OPENAI_MODEL;
      if (!model) { log('OPENAI_MODEL(또는 포털 설정의 GPT 모델명)이 없어 AI 요약을 건너뜁니다'); return ''; }
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: SYS }, { role: 'user', content: prompt }] })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
      return (j.choices?.[0]?.message?.content || '').trim();
    }
    log('AI 키가 없어 AI 요약 없이 발송합니다');
  } catch (e) { log('AI 요약 실패 — AI 요약 없이 발송:', e.message); }
  return '';
}

async function sendMail(cfg, rep) {
  const to = (cfg.recipients || []).filter((r) => r && r.on !== false && /@/.test(r.email || '') && (!r.kinds || r.kinds[rep.kind] !== false)).map((r) => r.email);
  if (!to.length) { log('메일 수신자가 없습니다'); return { mail: 0 }; }
  if (!env.SMTP_HOST) { log('SMTP 설정이 없어 메일을 건너뜁니다'); return { mail: 0 }; }
  const tr = nodemailer.createTransport({ host: env.SMTP_HOST, port: +(env.SMTP_PORT || 465), secure: +(env.SMTP_PORT || 465) === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
  if (DRY) { log('[dry-run] 메일 수신자', to); return { mail: to.length }; }
  await tr.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, bcc: to, subject: `${rep.title} — ${rep.summary}`, html: rep.html, text: (rep.ai ? rep.ai + '\n\n' : '') + rep.summary });
  return { mail: to.length };
}

async function sendPush(data, rep, urlPath) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) { log('VAPID 키가 없어 폰 알림을 건너뜁니다'); return { push: 0, gone: [] }; }
  webpush.setVapidDetails(env.MAIL_FROM ? `mailto:${env.MAIL_FROM.replace(/.*</, '').replace(/>.*/, '')}` : 'mailto:admin@example.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const subs = [];
  const offDaily = new Set((data.users || []).filter((u) => u && u.notify && (rep.kind === 'insight' ? u.notify.insight === false : (u.notify.daily === false || u.notify[rep.kind] === false))).map((u) => u.id));
  Object.entries(data.pushSubs || {}).forEach(([uid, list]) => !offDaily.has(uid) && (list || []).forEach((s) => { if (s && s.endpoint && s.on !== false && (!s.vk || s.vk === env.VAPID_PUBLIC_KEY)) subs.push({ uid, s }); }));
  const payload = JSON.stringify({ title: rep.title, body: rep.summary, url: (env.PORTAL_URL || '') + (urlPath || ('#/reports?t=' + rep.kind + '&k=' + rep.key)), tag: rep.kind + '-' + rep.key });
  let ok = 0; const gone = [];
  for (const { uid, s } of subs) {
    if (DRY) { ok++; continue; }
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 6 * 3600 }); ok++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) gone.push(s.endpoint); log('알림 실패', uid, e.statusCode || e.message); }
  }
  return { push: ok, gone };
}

/* 이번 실행에서 보낼 보고서 고르기 */
function due(data, cfg, now) {
  const kstHour = (now.getUTCHours() + 9) % 24;
  const today = Core.kstDate(0, now);
  const dow = new Date(today + 'T00:00:00Z').getUTCDay();
  const hour = cfg.hour == null ? 7 : +cfg.hour;
  /* GitHub 예약 실행은 몇 시간씩 늦거나 건너뛸 때가 많아(예: 01:28 → 06:14 → 그다음 없음), 정한 시각 이후 그날 안에는 아직 안 보낸 보고를 이어서 보냄 */
  const inWin = (h) => kstHour >= h;
  const done = (s) => !!(s && (s.at || (s.tries || 0) >= 3));   /* 보냈거나, 메일 실패가 3번 쌓였으면 그날은 그만 */
  const out = [];
  const KIND = (env.KIND || '').toLowerCase();
  if (FORCE) {   /* 수동 실행: 고른 종류만 (기본 일일) */
    (KIND ? KIND.split(',') : ['daily']).map((k) => k.trim()).filter((k) => ['daily', 'weekly', 'monthly'].indexOf(k) >= 0).forEach((k) => out.push(k));
    return out;
  }
  if (cfg.enabled) {
    const days = cfg.days || [1, 2, 3, 4, 5, 6];
    const target = Core.kstDate(-1, now);
    if (inWin(hour) && days.indexOf(dow) >= 0 && !done(data.dailyReports?.[target]?.sent)) out.push('daily');
    else if (done(data.dailyReports?.[target]?.sent)) log(`일일: ${target} 보고는 이미 처리됨`, JSON.stringify(data.dailyReports[target].sent));
    else log(`일일: 보낼 때가 아님 (지금 ${kstHour}시 · ${'일월화수목금토'[dow]}요일, 설정 ${hour}시 이후 · 발송 요일 ${days.map((d) => '일월화수목금토'[d]).join('')})`);
  } else log('일일 보고 자동 발송이 꺼져 있습니다');
  const W = cfg.weekly || {}, Mo = cfg.monthly || {};
  if (W.enabled !== false && (cfg.enabled || W.enabled)) {
    const wh = W.hour == null ? hour : +W.hour;
    const key = Core.period('weekly', today).key;
    if (dow === 1 && inWin(wh) && !done(data.weeklyReports?.[key]?.sent)) out.push('weekly');
  }
  if (Mo.enabled !== false && (cfg.enabled || Mo.enabled)) {
    const mh = Mo.hour == null ? hour : +Mo.hour;
    const key = Core.period('monthly', today).key;
    if (today.slice(8) === '01' && inWin(mh) && !done(data.monthlyReports?.[key]?.sent)) out.push('monthly');
  }
  return out;
}

async function sendOne(kind, data, cfg, NF, TPL, now) {
  const base = { kind, sections: cfg.sections, portalUrl: env.PORTAL_URL || cfg.portalUrl, templates: TPL, now };
  if (kind === 'daily') base.date = env.REPORT_DATE || Core.kstDate(-1, now); else base.ref = env.REPORT_DATE || Core.kstDate(0, now);
  let rep = Core.report(data, NF, base);
  const ai = await aiSummary(cfg, rep.text, kind);
  if (ai) rep = { ...Core.report(data, NF, { ...base, ai }), ai };
  log(rep.title, '·', rep.summary, ai ? '· AI 요약 포함' : '');
  let m = { mail: 0 }, mailErr = '';
  try { m = await sendMail(cfg, rep); }
  catch (e) {
    mailErr = (e.code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(e.message)) ? `메일 서버 주소(SMTP_HOST)를 찾을 수 없습니다 — Secret 값을 smtp.gmail.com 처럼 주소만 넣었는지 확인하세요` :
      (e.responseCode === 535 || /auth|login/i.test(e.message)) ? `메일 로그인 실패 — SMTP_USER/SMTP_PASS(앱 비밀번호)와 메일의 SMTP 사용 설정을 확인하세요 (${e.message})` : e.message;
    log('메일 발송 실패:', mailErr);
  }
  /* 메일이 실패해 다음 시각에 다시 보낼 때, 폰 알림은 처음 한 번만 */
  const prev = ((data[STORE[kind][0]] || {})[rep.key] || {}).sent || {};
  const p = prev.push ? { push: prev.push, gone: [] } : await sendPush(data, rep);
  const sent = { at: mailErr ? '' : new Date().toISOString(), mail: m.mail, push: p.push, by: 'github-actions', error: mailErr || undefined, tries: (prev.tries || 0) + 1 };
  if (DRY) { log('[dry-run] 저장 생략', sent); fs.writeFileSync(`report-preview-${kind}.html`, rep.html); return { ok: !mailErr }; }
  await saveReport(rep, sent);
  if (p.gone.length) {
    const d2 = await readState();
    Object.keys(d2.pushSubs || {}).forEach((u) => { d2.pushSubs[u] = (d2.pushSubs[u] || []).filter((s) => p.gone.indexOf(s.endpoint) < 0); });
    await fetch(`${SB}/rest/v1/app_state?id=eq.1`, { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ data: d2, updated_at: new Date().toISOString() }) });
  }
  if (mailErr) { log('보고서는 포털에 저장했지만 메일은 보내지 못했습니다:', mailErr); return { ok: false }; }
  log('완료', kind, sent);
  return { ok: true };
}

/* 공지사항 「자동 인사이트」: 전날 기록 분석 → 저장 · 🔴 항목 폰 알림 */
async function runInsights(data, cfg, NF, TPL, now) {
  const D = env.REPORT_DATE || Core.kstDate(-1, now);
  let L = Core.insights(data, NF, { date: D, templates: TPL, now });
  let digest = '';
  if (L.length && cfg.ai !== false) {
    const txt = L.map((x) => `[${{ red: '즉시 확인', amber: '관찰', green: '참고' }[x.level]}] ${x.cat} · ${x.title} — ${x.body}`).join('\n');
    digest = await aiSummary({ ...cfg, ai: true }, txt, 'insight');
  }
  const fresh = await readState();
  const r = Core.mergeInsights(fresh.insights, L, D, new Date().toISOString());
  fresh.insights = r.store;
  if (digest) { fresh.insights.digest = Object.assign({}, fresh.insights.digest || {}); fresh.insights.digest[D] = digest.replace(/\s+/g, ' ').trim().slice(0, 400); const ks = Object.keys(fresh.insights.digest).sort(); while (ks.length > 30) delete fresh.insights.digest[ks.shift()]; }
  log(`인사이트 ${D}: 찾은 것 ${L.length}건 · 새 글 ${r.added.length}건`, digest ? '· AI 브리핑 포함' : '');
  if (DRY) return;
  const w = await fetch(`${SB}/rest/v1/app_state?id=eq.1`, { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ data: fresh, updated_at: new Date().toISOString() }) });
  if (!w.ok) throw new Error(`인사이트 저장 실패 ${w.status}`);
  const reds = r.added.filter((x) => x.level === 'red');
  if (reds.length) await sendPush(fresh, { kind: 'insight', key: D, date: D, title: '🔴 설비 · 품질 인사이트', summary: reds.length === 1 ? reds[0].title : `${reds[0].title} 외 ${reds.length - 1}건` }, '#/notice?t=auto');
}

/* 자료·안전 「업계 안전 뉴스」: 뉴스 검색(구글 뉴스 RSS)으로 유업 · 음료 · 식품 제조업 사건사고 기사를 모아 저장 */
const NEWS_Q = ['우유 공장 사고', '유업 공장 사고', '유제품 공장 사망', '음료 공장 사고', '음료 공장 끼임', '식품공장 끼임 사망', '식품공장 화재', '식품공장 암모니아 누출',
  '식품 제조 중대재해', '두유 공장', '우유 회수 식약처', '음료 회수 이물'];
const NEWS_HIT = /(사망|숨져|숨진|숨지|부상|다쳐|사고|화재|불이|불나|폭발|누출|질식|끼임|끼여|끼어|협착|추락|깔려|중대재해|작업중지|회수|리콜|이물|식중독|판매\s*중단|세균|대장균)/;
const NEWS_IND = /(우유|유업|유제품|낙농|목장|음료|두유|주스|커피|식품|제과|제빵|빵|라면|면|공장|가공)/;
const NEWS_NO = /(주가|실적|출시|할인|이벤트|광고|매출|인사|증시|신제품|프로모션|캠페인|기부|후원|협약|수상)/;
function newsCat(t) {
  if (/끼|협착|말려|압착|깔려|팔레타이저|컨베이어|배합기|롤러/.test(t)) return '끼임·협착';
  if (/질식|밀폐|탱크|사일로|맨홀|가스\s*중독/.test(t)) return '밀폐공간·질식';
  if (/암모니아|누출|가스/.test(t)) return '가스 누출';
  if (/화재|불이|불나|폭발|연기/.test(t)) return '화재·폭발';
  if (/회수|리콜|이물|식중독|대장균|세균|판매\s*중단|식약처/.test(t)) return '식품안전·회수';
  if (/중대재해|벌금|선고|기소|재판|법/.test(t)) return '법·제도';
  return '기타';
}
function unent(s) { return String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) | 0; return (h >>> 0).toString(36); }
async function runNews(cfg, now) {
  const found = [], seen = new Set();
  const cut = new Date(now.getTime() - 60 * 86400000).toISOString().slice(0, 10);
  for (const q of NEWS_Q) {
    try {
      const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:60d')}&hl=ko&gl=KR&ceid=KR:ko`, { headers: { 'User-Agent': 'Mozilla/5.0 (portal safety news)' } });
      if (!r.ok) { log('뉴스 검색 실패', q, r.status); continue; }
      const xml = await r.text();
      for (const it of xml.split('<item>').slice(1)) {
        const g = (t) => { const m = it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? unent(m[1]) : ''; };
        let title = g('title'); const link = g('link'), src = g('source'), pd = g('pubDate');
        if (!title || !link) continue;
        if (src && title.endsWith(' - ' + src)) title = title.slice(0, -(src.length + 3));
        const d = pd ? new Date(pd).toISOString().slice(0, 10) : '';
        if (!d || d < cut) continue;
        if (!NEWS_HIT.test(title) || !NEWS_IND.test(title + ' ' + q) || NEWS_NO.test(title)) continue;
        const key = title.replace(/[^가-힣A-Za-z0-9]/g, '').slice(0, 26);
        if (seen.has(key)) continue; seen.add(key);
        found.push({ id: 'g-' + hash(key), d, src, title, url: link, cat: newsCat(title), auto: 1, tags: [q.split(' ')[0]] });
      }
    } catch (e) { log('뉴스 검색 오류', q, e.message); }
  }
  /* AI 키가 있으면: 관련 없는 기사 거르기 + 한두 문장 요약 */
  let list = found;
  if (found.length && env.ANTHROPIC_API_KEY && cfg.ai !== false) {
    try {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const body = found.map((x, i) => `${i}. [${x.d}] ${x.title} (${x.src})`).join('\n');
      const res = await client.messages.create({ model: cfg.model || 'claude-opus-5-5', max_tokens: 8000,
        system: '유업 · 음료 · 식품 제조 공장의 안전 담당자를 돕습니다. 기사 제목 목록을 보고, 제조 현장의 안전사고 · 화재 · 가스 누출 · 식품안전 사고(회수 등) · 관련 법적 처벌과 관계있는 기사만 고르세요. 각 기사에 대해 제목에 있는 사실만으로 한국어 한 문장 요약을 쓰세요(추측 금지). JSON 배열만 출력: [{"i":번호,"keep":true|false,"sum":"요약"}]',
        messages: [{ role: 'user', content: body }] });
      const txt = textOf(res.content); const m = txt.match(/\[[\s\S]*\]/);
      if (m) { const arr = JSON.parse(m[0]); const by = {}; arr.forEach((o) => { by[o.i] = o; }); list = found.filter((x, i) => !by[i] || by[i].keep !== false).map((x, i0) => { const o = by[found.indexOf(x)]; return o && o.sum ? { ...x, sum: String(o.sum).slice(0, 220) } : x; }); }
    } catch (e) { log('뉴스 AI 정리 실패 — 제목만 저장', e.message); }
  }
  const fresh = await readState();
  const sn = fresh.safetyNews = fresh.safetyNews || { items: [] };
  const have = new Set((sn.items || []).map((x) => x.id));
  const add = list.filter((x) => !have.has(x.id));
  const keepCut = new Date(now.getTime() - 365 * 86400000).toISOString().slice(0, 10);
  sn.items = (sn.items || []).concat(add).filter((x) => !x.auto || x.d >= keepCut).sort((a, b) => String(b.d).localeCompare(String(a.d)));
  const autos = sn.items.filter((x) => x.auto); if (autos.length > 150) { const drop = new Set(autos.slice(150).map((x) => x.id)); sn.items = sn.items.filter((x) => !drop.has(x.id)); }
  sn.updatedAt = new Date().toISOString();
  log(`안전 뉴스: 검색 ${found.length}건 · 새로 추가 ${add.length}건`);
  if (DRY) return;
  const w = await fetch(`${SB}/rest/v1/app_state?id=eq.1`, { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ data: fresh, updated_at: new Date().toISOString() }) });
  if (!w.ok) throw new Error(`안전 뉴스 저장 실패 ${w.status}`);
}

async function main() {
  const now = env.NOW ? new Date(env.NOW) : new Date();   // NOW: 시험용 시각 (보통은 비움)
  let data = await readState();
  const cfg = data.reportCfg || {};
  const kinds = due(data, cfg, now);
  const NF = loadNotionFinal(), TPL = loadTemplates();
  /* 인사이트: 일일 보고 시각(설정)에 매일, 또는 수동 실행에서 kind에 insight를 고른 경우 */
  const kstHour = (now.getUTCHours() + 9) % 24, hour = cfg.hour == null ? 7 : +cfg.hour;
  const wantIns = FORCE ? /insight/.test(env.KIND || '') : ((cfg.insights || {}).enabled !== false && kstHour >= hour && String((data.insights || {}).lastD || '') < Core.kstDate(-1, now));
  if (wantIns) { try { await runInsights(data, cfg, NF, TPL, now); data = await readState(); } catch (e) { console.error('[daily-report] 인사이트 실패:', e.message); process.exitCode = 1; } }
  /* 업계 안전 뉴스: 하루 한 번 (보고서 발송 시각) 또는 수동 실행 kind=news */
  const wantNews = FORCE ? /news/.test(env.KIND || '') : (kstHour >= hour && String((data.safetyNews || {}).updatedAt || '').slice(0, 10) < Core.kstDate(0, now));
  if (wantNews) { try { await runNews(cfg, now); data = await readState(); } catch (e) { console.error('[daily-report] 안전 뉴스 실패:', e.message); } }
  if (!kinds.length) { log('이번 시각에 보낼 보고서가 없습니다'); return; }
  let fail = 0;
  for (const kind of kinds) {
    try { const r = await sendOne(kind, data, cfg, NF, TPL, now); if (!r.ok) fail++; }
    catch (e) { fail++; console.error('[daily-report]', kind, '실패:', e.message); }
    data = await readState().catch(() => data);
  }
  if (fail) process.exitCode = 1;
}

/* 실행 결과를 포털 데이터(reportRun)에 남김 — 포털 「보고서 자동화 관리 → 발송 상태 · 점검」에서 확인
   (비밀 값은 넣지 않고 「있음/없음」만) · 저장 횟수를 줄이려고 발송 시각부터 6시간 안 · 보낸 것이 있거나 실패했을 때만 */
async function saveRun(now, err) {
  try {
    if (DRY) return;
    const data = await readState(), cfg = data.reportCfg || {};
    const kstHour = (now.getUTCHours() + 9) % 24, hour = cfg.hour == null ? 7 : +cfg.hour;
    const inWin = kstHour >= hour && kstHour < hour + 3;
    if (!inWin && !err && !FORCE && !RUNLOG.some((l) => /완료|실패/.test(l))) return;
    data.reportRun = { at: new Date().toISOString(), ok: !err && !process.exitCode, force: FORCE, kstHour, err: err ? String(err).slice(0, 300) : '',
      log: RUNLOG.slice(-14), has: { smtpHost: !!env.SMTP_HOST, smtpUser: !!env.SMTP_USER, smtpPass: !!env.SMTP_PASS, mailFrom: !!env.MAIL_FROM, ai: !!(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY), vapid: !!env.VAPID_PRIVATE_KEY, portalUrl: !!env.PORTAL_URL } };
    await fetch(`${SB}/rest/v1/app_state?id=eq.1`, { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ data, updated_at: new Date().toISOString() }) });
  } catch (e) { console.error('[daily-report] 실행 기록 저장 실패:', e.message); }
}
const NOW0 = env.NOW ? new Date(env.NOW) : new Date();
main().then(() => saveRun(NOW0, '')).catch(async (e) => { console.error('[daily-report] 실패:', e.message); await saveRun(NOW0, e.message); process.exit(1); });
