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

function log(...a) { console.log('[daily-report]', ...a); }
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

async function sendPush(data, rep) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) { log('VAPID 키가 없어 폰 알림을 건너뜁니다'); return { push: 0, gone: [] }; }
  webpush.setVapidDetails(env.MAIL_FROM ? `mailto:${env.MAIL_FROM.replace(/.*</, '').replace(/>.*/, '')}` : 'mailto:admin@example.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const subs = [];
  const offDaily = new Set((data.users || []).filter((u) => u && u.notify && (u.notify.daily === false || u.notify[rep.kind] === false)).map((u) => u.id));
  Object.entries(data.pushSubs || {}).forEach(([uid, list]) => !offDaily.has(uid) && (list || []).forEach((s) => { if (s && s.endpoint && s.on !== false && (!s.vk || s.vk === env.VAPID_PUBLIC_KEY)) subs.push({ uid, s }); }));
  const payload = JSON.stringify({ title: rep.title, body: rep.summary, url: (env.PORTAL_URL || '') + '#/reports?t=' + rep.kind + '&k=' + rep.key, tag: rep.kind + '-' + rep.key });
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
  const out = [];
  const KIND = (env.KIND || '').toLowerCase();
  if (FORCE) {   /* 수동 실행: 고른 종류만 (기본 일일) */
    (KIND ? KIND.split(',') : ['daily']).forEach((k) => out.push(k.trim()));
    return out;
  }
  if (cfg.enabled) {
    const days = cfg.days || [1, 2, 3, 4, 5, 6];
    const target = Core.kstDate(-1, now);
    if (kstHour === hour && days.indexOf(dow) >= 0 && !data.dailyReports?.[target]?.sent?.at) out.push('daily');
    else log(`일일: 보낼 때가 아님 (지금 ${kstHour}시 · ${'일월화수목금토'[dow]}요일, 설정 ${hour}시)`);
  } else log('일일 보고 자동 발송이 꺼져 있습니다');
  const W = cfg.weekly || {}, Mo = cfg.monthly || {};
  if (W.enabled !== false && (cfg.enabled || W.enabled)) {
    const wh = W.hour == null ? hour : +W.hour;
    const key = Core.period('weekly', today).key;
    if (dow === 1 && kstHour === wh && !data.weeklyReports?.[key]?.sent?.at) out.push('weekly');
  }
  if (Mo.enabled !== false && (cfg.enabled || Mo.enabled)) {
    const mh = Mo.hour == null ? hour : +Mo.hour;
    const key = Core.period('monthly', today).key;
    if (today.slice(8) === '01' && kstHour === mh && !data.monthlyReports?.[key]?.sent?.at) out.push('monthly');
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
  const p = await sendPush(data, rep);
  const sent = { at: mailErr ? '' : new Date().toISOString(), mail: m.mail, push: p.push, by: 'github-actions', error: mailErr || undefined };
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

async function main() {
  const now = env.NOW ? new Date(env.NOW) : new Date();   // NOW: 시험용 시각 (보통은 비움)
  let data = await readState();
  const cfg = data.reportCfg || {};
  const kinds = due(data, cfg, now);
  if (!kinds.length) { log('이번 시각에 보낼 보고서가 없습니다'); return; }
  const NF = loadNotionFinal(), TPL = loadTemplates();
  let fail = 0;
  for (const kind of kinds) {
    try { const r = await sendOne(kind, data, cfg, NF, TPL, now); if (!r.ok) fail++; }
    catch (e) { fail++; console.error('[daily-report]', kind, '실패:', e.message); }
    data = await readState().catch(() => data);
  }
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error('[daily-report] 실패:', e.message); process.exit(1); });
