#!/usr/bin/env node
/* eslint-disable no-useless-escape */
/**
 * ============================================================================
 *  ACLClouds (https://aclclouds.com) 免费 Discord Bot 服务器自动续期
 * ----------------------------------------------------------------------------
 *  技术栈 : Node.js 18+ / Playwright (Chromium) / GitHub Actions
 *  录制   : AgentScribe session 461bb59b (/server/<id>, 36 DOM + 49 network)
 *  关键发现:
 *    GET /api/client/servers/<id> 回包 attributes 含续期三件套:
 *      expires_at (ISO, 如 "2026-09-28T10:01:56+02:00")
 *      can_renew  (boolean) —— 门控只跟它走
 *      plan.renewal_days = 4
 *    认证 : session-cookie (remember_web_* + __Host-aclclouds_session + XSRF-TOKEN,
 *      API 请求头 X-XSRF-TOKEN = decodeURIComponent(XSRF-TOKEN cookie))
 *  主路线 : API 预检 (can_renew=false 直接 SKIP 免开浏览器) +
 *           到期才开浏览器点 Renew（真实续期按钮选择器待 can_renew=true 时补录确认，
 *           当前用文案泛匹配 Renew/Confirm/Yes）。
 *  注意   : 目录下旧 app.py/README/workflow 是 katabump 残留，已废弃，勿用。
 *
 *  必填环境变量（二选一提供凭证）:
 *    AUTH_STATE / AUTH_STATE_FILE        Playwright storageState JSON（推荐，录制即得）
 *    ACL_EMAIL / ACL_PASSWORD            账密登录（best-effort，登录页结构未完全确认）
 *    SERVER_PAGE_URL                     服务器页面地址，多个用换行/逗号分隔
 *  可选环境变量:
 *    SERVER_ID / GH_TOKEN + AUTO_UPDATE_STATE / TG_BOT_TOKEN / TG_CHAT_ID
 *  网络   : NODE_LINK 经 sing-box 本地代理（参考 HidenCloud），代理不可连自动直连。
 *    DRY_RUN / HEADLESS / TIMEZONE / LOCALE / NAV_TIMEOUT / LOGIN_URL
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { chromium } = require('playwright');

/* ============================== 配置区 ============================== */

const env = (k, d = '') => (process.env[k] === undefined ? d : String(process.env[k])).trim() || d;
const bool = (k, d = false) => {
  const v = env(k).toLowerCase();
  if (!v) return d;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v);
};
const num = (k, d) => {
  const v = parseFloat(env(k));
  return Number.isFinite(v) ? v : d;
};

const CFG = {
  loginUrl: env('LOGIN_URL', 'https://aclclouds.com/auth/login'),
  serverBase: env('SERVER_BASE', 'https://aclclouds.com/server/'),
  apiBase: env('API_BASE', 'https://aclclouds.com/api/client/servers/'),
  email: env('ACL_EMAIL'),
  password: env('ACL_PASSWORD'),
  authStateRaw: env('AUTH_STATE'),
  authStateFile: env('AUTH_STATE_FILE'),
  ghToken: env('GH_TOKEN'),
  autoUpdateState: bool('AUTO_UPDATE_STATE', false),
  repo: env('GITHUB_REPOSITORY'),
  tgToken: env('TG_BOT_TOKEN'),
  tgChatId: env('TG_CHAT_ID'),
  proxyUrl: env('PROXY_URL'),
  headless: bool('HEADLESS', true),
  dryRun: bool('DRY_RUN', false),
  timezone: env('TIMEZONE', 'Asia/Shanghai'),
  locale: env('LOCALE', 'en-US'),
  channel: env('BROWSER_CHANNEL'),
  navTimeout: num('NAV_TIMEOUT', 90000),
  shotDir: env('SHOT_DIR', 'screenshots'),
  ua: env('USER_AGENT',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
};

/* ============================== 小工具 ============================== */

const nowStr = () => new Date().toLocaleString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${nowStr()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 解析目标服务器列表：完整 URL 或裸 ID */
function parseTargets() {
  const raw = [env('SERVER_PAGE_URL'), env('SERVER_ID')].filter(Boolean).join('\n');
  const out = [];
  for (const line of raw.split(/[\r\n,;]+/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^https?:\/\//i.test(t)) out.push(t);
    else if (/^[0-9a-zA-Z_-]{4,}$/.test(t)) out.push(CFG.serverBase + t);
  }
  return [...new Set(out)];
}

function serverIdOf(url) {
  const m = String(url).match(/server\/([0-9a-zA-Z-]+)/);
  return m ? m[1] : (String(url).split('/').pop() || 'unknown');
}

/** TCP 探测 host:port 是否可连（sing-box 存活校验），不通自动直连 */
function tcpProbe(host, port, ms = 5000) {
  return new Promise((resolve) => {
    const net = require('net');
    const s = new net.Socket();
    let done = false;
    const fin = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
    s.setTimeout(ms);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
  });
}

function parseProxyHostPort(p) {
  try {
    const u = new URL(p);
    if (!u.hostname || !u.port) return null;
    return { host: u.hostname, port: Number(u.port) };
  } catch { return null; }
}

/** page.goto 带重试：ERR_CONNECTION_RESET 等网络抖动退避重试 */
async function gotoRetry(page, url, opts = {}, retries = 3) {
  let last;
  for (let i = 1; i <= retries; i++) {
    try { return await page.goto(url, opts); } catch (e) {
      last = e;
      log(`⚠️ 导航失败(${i}/${retries}): ${String(e.message).split('\n')[0].slice(0, 120)}`);
      if (i < retries) await sleep(3000 * i);
    }
  }
  throw last;
}

/** 原生 https 发 TG 通知（不引额外依赖） */
function sendTelegram(text) {
  return new Promise((resolve) => {
    if (!CFG.tgToken || !CFG.tgChatId) {
      log('⚠️ 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过通知');
      return resolve(false);
    }
    const data = JSON.stringify({ chat_id: CFG.tgChatId, text });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${CFG.tgToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000,
    }, (r) => {
      let buf = '';
      r.on('data', (c) => (buf += c));
      r.on('end', () => {
        try {
          const j = JSON.parse(buf);
          log(j.ok ? '📢 TG 通知已送达' : `⚠️ TG 通知失败: ${(j.description || buf).slice(0, 120)}`);
          resolve(!!j.ok);
        } catch { log('⚠️ TG 响应解析失败'); resolve(false); }
      });
    });
    req.on('error', (e) => { log(`⚠️ TG 发送异常: ${e.message}`); resolve(false); });
    req.on('timeout', () => { req.destroy(new Error('timeout')); resolve(false); });
    req.write(data);
    req.end();
  });
}

async function safeShot(page, name) {
  try {
    if (!fs.existsSync(CFG.shotDir)) fs.mkdirSync(CFG.shotDir, { recursive: true });
    const file = path.join(CFG.shotDir, name.endsWith('.png') ? name : `${name}.png`);
    await page.screenshot({ path: file, fullPage: false, timeout: 8000 });
    log(`📸 截图: ${file}`);
    return file;
  } catch (e) {
    log(`⚠️ 截图跳过: ${e.message}`);
    return null;
  }
}

/* ============================== 登录态 ============================== */

/** 读取 AUTH_STATE（内联 JSON / base64(JSON) / 文件路径）；兼容 storageState: 前缀粘贴 */
function loadAuthState() {
  const candidates = [];
  if (CFG.authStateFile && fs.existsSync(CFG.authStateFile)) candidates.push(fs.readFileSync(CFG.authStateFile, 'utf8'));
  if (CFG.authStateRaw) candidates.push(CFG.authStateRaw);
  const stripPrefix = (s) => {
    const t = String(s || '').trim();
    const m = t.match(/^(?:(?:const|let|var)\s+)?storageState\s*[:=]\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (m) return m[1];
    const i = t.indexOf('{');
    const j = t.lastIndexOf('}');
    if (i > 0 && j > i) {
      const sub = t.slice(i, j + 1);
      try { JSON.parse(sub); return sub; } catch { /* not json */ }
    }
    return t;
  };
  for (const c of candidates) {
    const cleaned = stripPrefix(c);
    const tries = [cleaned];
    try { tries.push(Buffer.from(cleaned, 'base64').toString('utf8')); } catch { /* ignore */ }
    for (const t of tries) {
      try {
        const j = JSON.parse(t);
        if (j && (Array.isArray(j.cookies) || Array.isArray(j.origins))) return j;
      } catch { /* ignore */ }
    }
  }
  if (CFG.authStateRaw) log(`⚠️ AUTH_STATE 已配置(${CFG.authStateRaw.length}字)但解析失败：需纯JSON{"cookies":[],"origins":[]}`);
  return null;
}

/** storageState → Cookie 请求头 */
function cookieHeaderFromState(state) {
  try {
    return (state.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
  } catch { return ''; }
}

/** XSRF-TOKEN cookie → X-XSRF-TOKEN 请求头（录制：解码后原文） */
function xsrfHeaderFromState(state) {
  try {
    const c = (state.cookies || []).find((x) => x.name === 'XSRF-TOKEN');
    if (!c) return null;
    try { return decodeURIComponent(c.value); } catch { return c.value; }
  } catch { return null; }
}

function httpsGetJson(urlStr, headers) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': CFG.ua, ...headers }, timeout: 20000,
    }, (r) => {
      let buf = '';
      r.on('data', (c) => (buf += c));
      r.on('end', () => resolve({ status: r.statusCode, body: buf }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); resolve({ status: 0, body: '', error: 'timeout' }); });
  });
}

/**
 * API 拉服务器详情。返回 { ok, can_renew, expires_at, status, suspended }。
 * 门控只跟 can_renew 布尔走；expires_at 仅展示与复核。
 */
async function apiServerDetail(id, state) {
  const fail = (note) => ({ ok: false, note });
  if (!state) return fail('无登录态');
  const xsrf = xsrfHeaderFromState(state);
  if (!xsrf) return fail('登录态缺 XSRF-TOKEN');
  const r = await httpsGetJson(`${CFG.apiBase}${id}`, {
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-XSRF-TOKEN': xsrf,
    Cookie: cookieHeaderFromState(state),
    Referer: `${CFG.serverBase}${id}`,
  });
  if (r.status === 401 || r.status === 419) return fail(`登录态失效(HTTP ${r.status})`);
  if (r.status !== 200) return fail(`HTTP ${r.status}${r.error ? `(${r.error})` : ''}`);
  try {
    const j = JSON.parse(r.body);
    const a = j.attributes || j;
    return {
      ok: true,
      can_renew: a.can_renew === true,
      expires_at: a.expires_at || null,
      status: a.status || null,
      suspended: !!a.is_suspended,
    };
  } catch { return fail('回包无法解析'); }
}

/**
 * 预检。返回 { decision: 'SKIP' | 'GO' | 'FALLBACK', note, detail? }。
 * SKIP = can_renew=false，未到期；GO = can_renew=true；FALLBACK = 查不到，走浏览器兜底。
 */
async function apiCheckOne(url, id, state) {
  const d = await apiServerDetail(id, state);
  if (!d.ok) {
    log(`📡 预检失败(${d.note})，回退浏览器`);
    return { decision: 'FALLBACK', note: d.note };
  }
  if (d.can_renew) {
    log(`📡 预检: can_renew=true，到期需续 (expires_at=${d.expires_at || '?'})`);
    return { decision: 'GO', note: `can_renew=true (expires_at=${d.expires_at || '?'})`, detail: d };
  }
  log(`📡 预检: can_renew=false，未到期 (expires_at=${d.expires_at || '?'})`);
  return { decision: 'SKIP', note: `can_renew=false (expires_at=${d.expires_at || '?'})`, detail: d };
}

/* ============================== 浏览器续期 ============================== */

/** 是否已登录：页面出现服务器关键文案 */
async function isLoggedIn(page) {
  try {
    const txt = await page.evaluate(() => (document.body.innerText || '').slice(0, 2000)).catch(() => '');
    return /Time remaining|Free plan|Console|Dashboard/i.test(txt);
  } catch { return false; }
}

/** 文本候选点击 */
async function clickByText(scope, texts, opts = {}) {
  for (const t of texts) {
    try {
      const el = scope.locator(`button:has-text("${t}"), a:has-text("${t}"), [role="button"]:has-text("${t}")`).first();
      if (await el.isVisible({ timeout: opts.timeout || 1500 })) {
        await el.click({ timeout: 5000 });
        log(`👆 已点击: [${t}]`);
        return true;
      }
    } catch { /* next */ }
  }
  return false;
}

async function dumpState(context) {
  try {
    if (!fs.existsSync(CFG.shotDir)) fs.mkdirSync(CFG.shotDir, { recursive: true });
    const file = path.join(CFG.shotDir, 'storage-state.json');
    const st = await context.storageState({ path: file });
    const s = JSON.stringify(st);
    log(`💾 登录态已导出 ${file} (${s.length} bytes)`);
    return s;
  } catch (e) {
    log(`⚠️ 导出登录态失败: ${e.message}`);
    return null;
  }
}

async function updateGithubSecret(name, value) {
  if (!CFG.ghToken || !CFG.repo) { log('ℹ️ 未提供 GH_TOKEN/GITHUB_REPOSITORY，跳过回写 Secret'); return false; }
  const [owner, repo] = CFG.repo.split('/');
  try {
    const { execFile } = require('child_process');
    await new Promise((resolve, reject) => {
      execFile('gh', ['secret', 'set', name, '--body', value, '--repo', `${owner}/${repo}`],
        { env: { ...process.env, GH_TOKEN: CFG.ghToken }, timeout: 60000 },
        (err, so, se) => (err ? reject(new Error(se || err.message)) : resolve(so)));
    });
    log(`✅ 已更新 Secret: ${name}`);
    return true;
  } catch (e) {
    log(`⚠️ gh CLI 写入失败: ${String(e.message).slice(0, 200)}`);
    return false;
  }
}

/**
 * 单个服务器续期（can_renew=true 时才进）。
 * 真实续期按钮选择器待补录确认，当前用文案泛匹配。
 */
async function renewOneServer(context, url, idx, total, liveState) {
  const page = await context.newPage();
  const id = serverIdOf(url);
  const result = { idx, total, url, id, status: 'FAIL', before: null, after: null, note: '' };
  const t0 = Date.now();
  log(`\n──────── 服务器 [${idx}/${total}] ${id} ────────`);

  try {
    await gotoRetry(page, url, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
    await sleep(2500);

    if (!(await isLoggedIn(page))) {
      result.note = '未登录/被重定向';
      await safeShot(page, `server-${idx}-nologin.png`);
      return result;
    }

    const before = await apiServerDetail(id, liveState);
    result.before = before.ok ? (before.expires_at || '?') : '未读取到';
    log(`⏱️ 到期: ${result.before}`);

    if (CFG.dryRun) { result.status = 'PENDING'; result.note = 'DRY_RUN 演练，未点击'; return result; }

    // 找续期按钮（泛匹配；录制时 can_renew=false 故无精确选择器）
    const btn = page.locator('button, a, [role="button"]')
      .filter({ hasText: /^.*renew.*$/i }).first();
    let hasBtn = false;
    try {
      await btn.waitFor({ state: 'visible', timeout: 8000 });
      hasBtn = true;
      const label = (await btn.innerText().catch(() => 'Renew')).replace(/\s+/g, ' ').trim().slice(0, 60);
      log(`🔘 续期按钮: [${label}]`);
      await btn.click({ timeout: 8000 });
    } catch {
      hasBtn = await clickByText(page, ['Renew', 'Renew Server', 'Renew now'], { timeout: 1500 });
      if (!hasBtn) { result.note = '未找到 Renew 按钮（可能 UI 改版，需补录）'; await safeShot(page, `server-${idx}-norenew.png`); result.status = 'NO_BUTTON'; return result; }
    }
    await sleep(2000);

    // 确认弹窗（若有）
    const modal = page.locator('[role="dialog"], div.modal.show').last();
    try {
      await modal.waitFor({ state: 'visible', timeout: 8000 });
      const ok = await clickByText(modal, ['Renew', 'Confirm', 'Yes', 'Continue', 'Submit'], { timeout: 1200 });
      if (!ok) await clickByText(page.locator('body'), ['Confirm', 'Yes'], { timeout: 1000 }).catch(() => false);
    } catch { log('ℹ️ 无独立确认弹窗，继续'); }
    await sleep(5000);

    // 读页面 alert 判结果
    const alert = await page.evaluate(() => {
      const el = document.querySelector('div.alert');
      return el ? (el.innerText || '').trim().slice(0, 200) : '';
    }).catch(() => '');
    if (alert) log(`📩 页面提示: ${alert}`);
    const low = alert.toLowerCase();

    // 独立复核：重读 detail，expires_at 变化即成功
    const after = await apiServerDetail(id, liveState);
    result.after = after.ok ? (after.expires_at || '?') : '未读取到';
    log(`🔍 复核: ${result.before} ➔ ${result.after}`);
    await safeShot(page, `server-${idx}-verify.png`);

    if (/renewed|success|extended/.test(low) || (before.ok && after.ok && before.expires_at && after.expires_at && before.expires_at !== after.expires_at)) {
      result.status = 'SUCCESS';
      result.note = alert || `expires_at 已更新`;
      log('🎉 续期成功');
    } else if (/can't renew|unable|not yet|cooldown|too early/i.test(low)) {
      result.status = 'PENDING';
      result.note = alert || '未到续期窗口';
      log(`⏳ ${result.note}`);
    } else {
      result.status = 'FAIL';
      result.note = alert ? `点击完成但未确认: ${alert}` : '点击完成但时长未变化（需补录确认选择器）';
      await safeShot(page, `server-${idx}-fail.png`);
      log('❌ 后端未入账或无法确认');
    }
  } catch (e) {
    result.note = (result.note || '') + ` 异常: ${String(e.message).slice(0, 120)}`;
    await safeShot(page, `server-${idx}-error.png`);
    log(`❌ 处理异常: ${e.message}`);
  } finally {
    await page.close().catch(() => {});
    log(`⌛ 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  return result;
}

/* ============================== 登录 ============================== */

/** 账密登录（best-effort：登录页结构待确认，优先用 AUTH_STATE） */
async function doLogin(page) {
  log('🔑 账密登录（best-effort）');
  await gotoRetry(page, CFG.loginUrl, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
  await sleep(2500);
  if (await isLoggedIn(page)) { log('✅ 已有有效登录态，跳过登录'); return true; }
  try {
    const email = page.locator('input[type="email"], input[name*="email" i]').first();
    const pass = page.locator('input[type="password"]').first();
    await email.waitFor({ state: 'visible', timeout: 20000 });
    await email.fill(CFG.email);
    await pass.fill(CFG.password);
    await clickByText(page, ['Sign in', 'Log in', 'Login', 'Continue'], { timeout: 3000 });
    await sleep(3000);
  } catch (e) {
    log(`❌ 登录表单未找到: ${String(e.message).slice(0, 100)}`);
    return false;
  }
  const ok = await isLoggedIn(page);
  log(ok ? '✅ 登录成功' : '❌ 登录后未检测到服务器页');
  return ok;
}

/* ============================== 汇报 ============================== */

async function reportResults(results) {
  results.sort((a, b) => a.idx - b.idx);
  const ICON = { SUCCESS: '🟢', PENDING: '⚪', NO_BUTTON: '🟡', FAIL: '🔴' };
  const LABEL = { SUCCESS: '续期成功', PENDING: '无需续期', NO_BUTTON: '未找到按钮', FAIL: '失败' };
  const lines = results.map((r) =>
    `${ICON[r.status] || '❔'} <b>[${r.idx}/${r.total}] ${r.id}</b>\n   ${LABEL[r.status] || r.status}` +
    `${r.before ? ` | ${r.before}${r.after ? ` ➔ ${r.after}` : ''}` : ''}${r.note ? `\n   └ ${r.note}` : ''}`);
  const sum = `🖥 <b>ACLClouds 自动续期报告</b>\n\n${lines.join('\n')}\n\n<b>门控</b> can_renew 布尔 · <b>周期</b> 4天免费档\n<b>时间</b> ${nowStr()}`;
  await sendTelegram(sum);
  console.log('\n================ 汇总 ================');
  results.forEach((r) => console.log(`${ICON[r.status]} [${r.idx}/${r.total}] ${r.id} ${r.before}${r.after ? ' ➔ ' + r.after : ''} ${r.note}`));
  const fails = results.filter((r) => r.status === 'FAIL').length;
  process.exitCode = fails && fails === results.length ? 1 : 0;
}

/* ============================== 主流程 ============================== */

(async () => {
  const targets = parseTargets();
  if (!targets.length) {
    console.error('❌ 未配置 SERVER_PAGE_URL（或 SERVER_ID），脚本终止');
    process.exit(1);
  }
  const state = loadAuthState();
  if (!state && (!CFG.email || !CFG.password)) {
    console.error('❌ 需至少提供 AUTH_STATE，或 ACL_EMAIL + ACL_PASSWORD');
    process.exit(1);
  }

  log('#'.repeat(64));
  log('   ACLClouds (aclclouds.com) 自动续期  v1.0');
  log(`   目标数: ${targets.length} | 门控: can_renew 布尔 | DRY_RUN: ${CFG.dryRun}`);
  log(`   代理: ${CFG.proxyUrl || '直连'} | headless: ${CFG.headless} | 登录: ${state ? '登录态注入(可降级账密)' : '账密'}`);
  log('#'.repeat(64));

  if (!fs.existsSync(CFG.shotDir)) fs.mkdirSync(CFG.shotDir, { recursive: true });

  const launchOpts = {
    headless: CFG.headless,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage', '--window-size=1920,1080', '--lang=en-US', '--no-first-run',
    ],
  };
  if (CFG.proxyUrl) {
    const hp = parseProxyHostPort(CFG.proxyUrl);
    // sing-box 未起好/端口残留时直接直连，不穿透脏代理
    const alive = hp ? await tcpProbe(hp.host, hp.port, 5000) : false;
    if (alive) {
      try { launchOpts.proxy = { server: CFG.proxyUrl }; log(`🔗 代理存活: ${CFG.proxyUrl}，走代理`); } catch (e) { log(`⚠️ 代理参数无效: ${e.message}`); }
    } else {
      log(`⚠️ 代理不可连(${CFG.proxyUrl})，本次直连`);
      CFG.proxyUrl = '';
    }
  } else { log('🍭 直连模式（未配置 NODE_LINK 则 workflow 不起 sing-box）'); }
  if (CFG.channel) launchOpts.channel = CFG.channel;

  // 1) API 预检优先：can_renew=false 直接汇报退出，不启动浏览器
  const results = [];
  let browserTargets = targets.map((url, i) => ({ url, idx: i + 1 }));
  {
    log('📡 API 预检中（can_renew 门控，未到期免开浏览器）…');
    const remain = [];
    for (const t of browserTargets) {
      const c = await apiCheckOne(t.url, serverIdOf(t.url), state);
      if (c.decision === 'SKIP') {
        log(`⏳ [${t.idx}/${targets.length}] ${c.note}，跳过浏览器`);
        results.push({ idx: t.idx, total: targets.length, url: t.url, id: serverIdOf(t.url), status: 'PENDING', before: (c.detail && c.detail.expires_at) || null, after: null, note: c.note });
      } else {
        log(`➡️ [${t.idx}/${targets.length}] ${c.note}，走浏览器`);
        remain.push(t);
      }
    }
    browserTargets = remain;
    if (!browserTargets.length) {
      log('✅ 全部未到期，本次免开浏览器');
      await reportResults(results);
      return;
    }
  }

  // 2) 有到期目标才启动浏览器
  const browser = await chromium.launch(launchOpts);
  const ctxOpts = { viewport: { width: 1920, height: 1080 }, userAgent: CFG.ua, locale: CFG.locale, timezoneId: CFG.timezone };
  if (state) ctxOpts.storageState = state;
  const context = await browser.newContext(ctxOpts);

  let authOk = false;
  let dumped = null;
  const first = await context.newPage();
  try {
    if (state) {
      log('🍪 使用注入登录态访问目标页');
      await gotoRetry(first, browserTargets[0].url, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
      await sleep(2500);
      if (await isLoggedIn(first)) authOk = true;
      else log('⚠️ 登录态已失效，降级为账密登录');
    }
    if (!authOk && CFG.email && CFG.password) authOk = await doLogin(first);
    if (!authOk) {
      await safeShot(first, 'login-failed.png');
      await dumpState(context);
      throw new Error('登录失败（账密或登录态均不可用）');
    }
    dumped = await dumpState(context);
    if (dumped && CFG.autoUpdateState && CFG.ghToken) await updateGithubSecret('AUTH_STATE', dumped);
  } finally { await first.close().catch(() => {}); }

  let liveState = state;
  try { liveState = JSON.parse(dumped) || state; } catch { /* keep state */ }

  // 3) 登录后复检一次（token 刷新后 can_renew 可能已可读）
  {
    const remain = [];
    for (const t of browserTargets) {
      if (results.some((r) => r.idx === t.idx)) continue;
      const c = await apiCheckOne(t.url, serverIdOf(t.url), liveState);
      if (c.decision === 'SKIP') {
        log(`⏳ [${t.idx}/${targets.length}] 登录后复检：${c.note}，跳过浏览器`);
        results.push({ idx: t.idx, total: targets.length, url: t.url, id: serverIdOf(t.url), status: 'PENDING', before: (c.detail && c.detail.expires_at) || null, after: null, note: c.note });
      } else {
        remain.push(t);
      }
    }
    browserTargets = remain;
  }

  for (const t of browserTargets) {
    try { results.push(await renewOneServer(context, t.url, t.idx, targets.length, liveState)); }
    catch (e) { log(`❌ 服务器 ${t.idx} 未捕获异常: ${e.message}`); results.push({ idx: t.idx, total: targets.length, url: t.url, id: serverIdOf(t.url), status: 'FAIL', before: '-', after: '-', note: e.message.slice(0, 100) }); }
    await sleep(1500);
  }
  await context.storageState({ path: path.join(CFG.shotDir, 'storage-state-final.json') }).catch(() => {});
  await browser.close();
  log('🏁 浏览器已关闭');

  await reportResults(results);
})().catch(async (e) => {
  console.error('❌ 全局致命错误:', e.message);
  await sendTelegram(`🚨 <b>ACLClouds 运行异常</b>\n<code>${String(e.message).slice(0, 200)}</code>\n⏱ ${nowStr()}`);
  process.exit(1);
});
