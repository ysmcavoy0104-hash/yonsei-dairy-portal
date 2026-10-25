// 일일 보고서 자동 생성 · 메일 · 폰 알림 (GitHub Actions에서 매시간 실행 → 설정한 시각에만 발송)
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
async function saveReport(rep, sentInfo) {
  const data = await readState();
  data.dailyReports = data.dailyReports || {};
  data.dailyReports[rep.date] = { date: rep.date, title: rep.title, summary: rep.summary, html: rep.html, ai: rep.ai || '', stats: rep.stats, generatedAt: new Date().toISOString(), sent: sentInfo };
  const keys = Object.keys(data.dailyReports).sort();
  while (keys.length > 31) delete data.dailyReports[keys.shift()];
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

function textOf(blocks) { return (blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(); }
const FALLBACK_MODELS = /^(claude-opus-5-5|claude-opus-5|claude-fable-5-1|claude-fable-5|claude-sonnet-5-5)$/;

async function aiSummary(cfg, text) {
  if (!cfg.ai) return '';
  const prompt = `[하루치 데이터]\n${text}\n\n위 데이터로 오늘 아침 보고용 요약을 작성하세요.`;
  try {
    if (env.ANTHROPIC_API_KEY) {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const model = cfg.model || 'claude-opus-5-5';
      const req = { model, max_tokens: 16000, system: Core.AI_SYSTEM, messages: [{ role: 'user', content: prompt }] };
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
        body: JSON.stringify({ model, messages: [{ role: 'system', content: Core.AI_SYSTEM }, { role: 'user', content: prompt }] })
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
  const to = (cfg.recipients || []).filter((r) => r && r.on !== false && /@/.test(r.email || '')).map((r) => r.email);
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
  const offDaily = new Set((data.users || []).filter((u) => u && u.notify && u.notify.daily === false).map((u) => u.id));
  Object.entries(data.pushSubs || {}).forEach(([uid, list]) => !offDaily.has(uid) && (list || []).forEach((s) => { if (s && s.endpoint && s.on !== false && (!s.vk || s.vk === env.VAPID_PUBLIC_KEY)) subs.push({ uid, s }); }));
  const payload = JSON.stringify({ title: rep.title, body: rep.summary, url: (env.PORTAL_URL || '') + '#/reports?d=' + rep.date, tag: 'daily-' + rep.date });
  let ok = 0; const gone = [];
  for (const { uid, s } of subs) {
    if (DRY) { ok++; continue; }
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 6 * 3600 }); ok++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) gone.push(s.endpoint); log('알림 실패', uid, e.statusCode || e.message); }
  }
  return { push: ok, gone };
}

async function main() {
  const data = await readState();
  const cfg = data.reportCfg || {};
  if (!cfg.enabled && !FORCE) { log('보고서 자동 발송이 꺼져 있습니다 (포털 > 보고서 자동화)'); return; }
  const now = new Date();
  const kstHour = (now.getUTCHours() + 9) % 24;
  const today = Core.kstDate(0, now);
  const target = Core.kstDate(-1, now);
  const hour = cfg.hour == null ? 7 : +cfg.hour;
  const days = cfg.days || [1, 2, 3, 4, 5, 6]; // 0=일
  const dow = new Date(today + 'T00:00:00Z').getUTCDay();
  if (!FORCE) {
    if (kstHour !== hour) { log(`발송 시각이 아닙니다 (지금 ${kstHour}시, 설정 ${hour}시)`); return; }
    if (days.indexOf(dow) < 0) { log('오늘은 발송 요일이 아닙니다'); return; }
    if (data.dailyReports?.[target]?.sent?.at) { log('이미 발송했습니다', target); return; }
  }
  const NF = loadNotionFinal();
  let rep = Core.build(data, NF, { date: target, sections: cfg.sections, portalUrl: env.PORTAL_URL });
  const ai = await aiSummary(cfg, rep.text);
  if (ai) rep = { ...Core.build(data, NF, { date: target, sections: cfg.sections, portalUrl: env.PORTAL_URL, ai }), ai };
  log(rep.title, '·', rep.summary, ai ? '· AI 요약 포함' : '');
  let m = { mail: 0 }, mailErr = '';
  try { m = await sendMail(cfg, rep); }
  catch (e) {
    mailErr = (e.code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(e.message)) ? `메일 서버 주소(SMTP_HOST)를 찾을 수 없습니다 — Secret 값을 smtp.naver.com 처럼 주소만 넣었는지 확인하세요` :
      (e.responseCode === 535 || /auth|login/i.test(e.message)) ? `메일 로그인 실패 — SMTP_USER/SMTP_PASS(앱 비밀번호)와 메일의 SMTP 사용 설정을 확인하세요 (${e.message})` : e.message;
    log('메일 발송 실패:', mailErr);
  }
  const p = await sendPush(data, rep);
  const sent = { at: mailErr ? '' : new Date().toISOString(), mail: m.mail, push: p.push, by: 'github-actions', error: mailErr || undefined };
  if (DRY) { log('[dry-run] 저장 생략', sent); fs.writeFileSync('report-preview.html', rep.html); return; }
  await saveReport(rep, sent);
  if (p.gone.length) {
    const d2 = await readState();
    Object.keys(d2.pushSubs || {}).forEach((u) => { d2.pushSubs[u] = (d2.pushSubs[u] || []).filter((s) => p.gone.indexOf(s.endpoint) < 0); });
    await fetch(`${SB}/rest/v1/app_state?id=eq.1`, { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ data: d2, updated_at: new Date().toISOString() }) });
  }
  if (mailErr) { log('보고서는 포털에 저장했지만 메일은 보내지 못했습니다:', mailErr); process.exitCode = 1; return; }
  log('완료', sent);
}

main().catch((e) => { console.error('[daily-report] 실패:', e.message); process.exit(1); });
