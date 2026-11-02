/**
 * weather-wechat-bot（GitHub Actions 版）
 * 由 .github/workflows/weather.yml 每小时（北京时间 8-20 点）调度：
 * 多天气源交叉验证，可能降雨才推送到微信，同一天同时段不重复推送。
 * 与 Cloudflare Workers 版逻辑一致，方便二选一部署或互为备份。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const TIMEZONE = 'Asia/Shanghai';
const WINDOW_START = 8;  // 北京时间 08:00 开始
const WINDOW_END = 20;   // 20:00 结束（检查 8..19 这 12 个时段）

const REGIONS = [
  { id: 'huaxi',    name: '贵阳·花溪区',       lat: 26.4306, lon: 106.6703 },
  { id: 'shangjie', name: '福州·闽侯县上街镇', lat: 26.0830, lon: 119.2090 },
];

const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const MIN_SOURCES = Math.max(1, Number(process.env.MIN_SOURCES) || 2);
const THRESHOLD = Number(process.env.RAIN_PROB_THRESHOLD) || 50;

const { date, hour } = nowParts();
if (hour < WINDOW_START || hour > WINDOW_END) {
  console.log(`当前北京时间 ${hour} 时，不在监测窗口内，退出`);
  process.exit(0);
}

const sources = [
  {
    name: 'Open-Meteo',
    async fetch(region) {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${region.lat}&longitude=${region.lon}`
        + `&hourly=precipitation_probability,precipitation,weather_code&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=2`;
      const d = await fetchJSON(url);
      const rainHours = new Set(), probByHour = new Map();
      d.hourly.time.forEach((t, i) => {
        if (!t.startsWith(date)) return;
        const h = Number(t.slice(11, 13));
        if (h < WINDOW_START || h >= WINDOW_END) return;
        const prob = d.hourly.precipitation_probability?.[i] ?? 0;
        const mm = d.hourly.precipitation?.[i] ?? 0;
        const code = d.hourly.weather_code?.[i];
        probByHour.set(h, prob);
        if (prob >= THRESHOLD || mm > 0.1 || RAIN_CODES.has(code)) rainHours.add(h);
      });
      return { name: this.name, rainHours, probByHour };
    },
  },
];
if (process.env.QWEATHER_KEY) {
  sources.push({
    name: '和风天气',
    async fetch(region) {
      const d = await fetchJSON(`https://devapi.qweather.com/v7/weather/24h?location=${region.lon},${region.lat}&key=${process.env.QWEATHER_KEY}`);
      if (String(d.code) !== '200') throw new Error(`qweather code=${d.code}`);
      const rainHours = new Set(), probByHour = new Map();
      for (const it of d.hourly || []) {
        if (!String(it.fxTime).startsWith(date)) continue;
        const h = Number(String(it.fxTime).slice(11, 13));
        if (h < WINDOW_START || h >= WINDOW_END) continue;
        const pop = Number(it.pop ?? 0);
        probByHour.set(h, pop);
        if (/[雨雷]/.test(it.text) || pop >= THRESHOLD) rainHours.add(h);
      }
      return { name: this.name, rainHours, probByHour };
    },
  });
}
if (process.env.OWM_KEY) {
  sources.push({
    name: 'OpenWeatherMap',
    async fetch(region) {
      const d = await fetchJSON(`https://api.openweathermap.org/data/2.5/forecast?lat=${region.lat}&lon=${region.lon}&appid=${process.env.OWM_KEY}&units=metric`);
      const rainHours = new Set(), probByHour = new Map();
      for (const it of d.list || []) {
        const local = new Date(it.dt * 1000 + 8 * 3600 * 1000);
        const ds = local.toISOString().slice(0, 10), h = local.getUTCHours();
        if (ds !== date || h < WINDOW_START || h >= WINDOW_END) continue;
        const pop = Math.round((it.pop ?? 0) * 100);
        probByHour.set(h, pop);
        if (pop >= THRESHOLD || (it.rain && it.rain['3h'] > 0.1)) rainHours.add(h);
      }
      return { name: this.name, rainHours, probByHour };
    },
  });
}

let hasNew = false;
for (const region of REGIONS) {
  try {
    const results = await Promise.allSettled(sources.map(s => s.fetch(region)));
    const ok = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') ok.push(r.value);
      else console.warn(`[${region.id}] 源 ${sources[i].name} 不可用:`, r.reason?.message);
    });
    if (!ok.length) { console.error(`[${region.id}] 所有天气源失败，下次自动重试`); continue; }

    const votes = ok.filter(s => s.rainHours.size > 0);
    let shouldNotify = votes.length >= MIN_SOURCES;
    let reason = `${votes.length}/${ok.length} 个来源一致预报有雨`;
    if (!shouldNotify && ok.length === 1 && votes.length === 1) {
      const maxProb = Math.max(0, ...[...ok[0].probByHour.values()]);
      shouldNotify = maxProb >= Math.max(THRESHOLD, 60);
      reason = `仅 ${ok[0].name} 可用，其降雨概率 ${maxProb}%`;
    }
    console.log(`[${region.id}] votes=${votes.length}/${ok.length} -> ${shouldNotify ? '通知' : '静默'}`);
    if (!shouldNotify) continue;

    // 时段投票：多数源都报雨 = 大概率；只有单源报雨 = 可能有雨
    const hourVotes = new Map();
    for (const s of ok) for (const h of s.rainHours) {
      if (!hourVotes.has(h)) hourVotes.set(h, []);
      hourVotes.get(h).push(s.name);
    }
    const confirmed = new Set(), possible = new Set();
    for (const [h, names] of hourVotes) {
      (names.length >= Math.min(MIN_SOURCES, ok.length) ? confirmed : possible).add(h);
    }

    // 去重（state 目录由 actions/cache 保存）
    const st = loadState(region.id, date);
    const newC = [...confirmed].filter(h => !st.confirmed.includes(h));
    const newP = [...possible].filter(h => !st.possible.includes(h));
    if (!newC.length && !newP.length) { console.log(`[${region.id}] 无新增降雨时段，不重复通知`); continue; }
    st.confirmed.push(...newC);
    st.possible.push(...newP);
    saveState(region.id, date, st);
    hasNew = true;

    await notify(buildMessage(region, date, ok, confirmed, possible));
  } catch (e) {
    console.error(`[${region.id}] 处理失败:`, e.stack || e);
  }
}

// 若当天到 20 点后仍无任何状态文件，也不需要特殊处理；缓存按天自然被新 key 覆盖

/* ----------------------------- 工具 ----------------------------- */

function nowParts() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  });
  const p = {};
  for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

async function fetchJSON(url, opts = {}, timeoutMs = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

function stateFile(regionId) {
  mkdirSync('state', { recursive: true });
  return `state/${regionId}.json`;
}
function loadState(regionId, date) {
  try {
    const v = JSON.parse(readFileSync(stateFile(regionId), 'utf8'));
    if (v.date === date) return v;
  } catch { /* 首次运行无文件 */ }
  return { date, confirmed: [], possible: [] };
}
function saveState(regionId, date, st) { writeFileSync(stateFile(regionId), JSON.stringify(st)); }

function buildMessage(region, date, okSources, confirmed, possible) {
  const fmtH = h => `${String(h).padStart(2, '0')}时`;
  const groupHours = set => {
    const arr = [...set].sort((a, b) => a - b);
    const out = []; let s = arr[0], p = arr[0];
    for (const h of arr.slice(1)) { if (h === p + 1) { p = h; continue; } out.push(s === p ? fmtH(s) : `${fmtH(s)}–${fmtH(p)}`); s = p = h; }
    if (s !== undefined) out.push(s === p ? fmtH(s) : `${fmtH(s)}–${fmtH(p)}`);
    return out.join('、') || '无';
  };
  const srcLine = okSources.map(s => {
    const hours = [...s.rainHours].sort((a, b) => a - b);
    return `- ${s.name}：${hours.length ? hours.map(h => `${fmtH(h)}(${s.probByHour.get(h) ?? '?'}%)`).join(' ') : '无雨'}`;
  }).join('\n');
  return [
    `☔ **天气提醒 | ${region.name}**`,
    `今日（${date}）08:00–20:00 预计有雨`,
    confirmed.size ? `🌧 **大概率降雨时段：${groupHours(confirmed)}**` : '',
    possible.size ? `🌦 次要来源提示可能有雨：${groupHours(possible)}` : '',
    `**各来源预报：**`,
    srcLine,
  ].filter(Boolean).join('\n');
}

async function notify(message) {
  const jobs = [];
  if (process.env.WECOM_WEBHOOK) {
    jobs.push(fetchJSON(process.env.WECOM_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: message } }),
    }).then(r => { if (r.errcode !== 0) throw new Error(`wecom errcode=${r.errcode}`); console.log('已推送到企业微信'); }));
  }
  if (process.env.SERVERCHAN_KEY) {
    jobs.push(fetchJSON(`https://sctapi.ftqq.com/${process.env.SERVERCHAN_KEY}.send`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `title=${encodeURIComponent('☔ 天气提醒：今日可能有雨')}&desp=${encodeURIComponent(message)}`,
    }));
  }
  if (!jobs.length) throw new Error('未配置推送渠道！请在仓库 Secrets 中设置 WECOM_WEBHOOK 或 SERVERCHAN_KEY');
  const rs = await Promise.allSettled(jobs);
  rs.filter(r => r.status === 'rejected').forEach(r => console.error('推送失败:', r.reason?.message));
}
