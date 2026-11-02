/**
 * weather-wechat-bot（GitHub Actions 版）
 * 每天北京时间 07:30 运行一次：
 * 通过 Open-Meteo 的两个独立气象模型（best_match + ECMWF）交叉验证，
 * 检查当日 08:00–20:00 是否有雨，有雨则发送邮件警报，无雨则不发送。
 */

import tls from 'node:tls';

const TIMEZONE = 'Asia/Shanghai';
const WINDOW_START = 8;
const WINDOW_END = 20;

const REGIONS = [
  { id: 'huaxi',    name: '贵阳·花溪区',       lat: 26.4306, lon: 106.6703, email: '1418043295@qq.com' },
  { id: 'shangjie', name: '福州·闽侯县上街镇', lat: 26.0830, lon: 119.2090, email: '1634527469@qq.com' },
];

const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const THRESHOLD = 50;
const MIN_SOURCES = 2;

/* ----------------------------- 数据源 ----------------------------- */

function makeOpenMeteoSource(modelName, label) {
  return {
    name: label,
    async fetch(region, date) {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${region.lat}&longitude=${region.lon}`
        + `&hourly=precipitation_probability,precipitation,weather_code&models=${modelName}&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=2`;
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
  };
}

const sources = [
  makeOpenMeteoSource('best_match', 'Open-Meteo (综合模型)'),
  makeOpenMeteoSource('ecmwf_ifs025', 'Open-Meteo (ECMWF模型)'),
];

// Optional extra sources if keys provided
if (process.env.QWEATHER_KEY) {
  sources.push({
    name: '和风天气',
    async fetch(region, date) {
      const d = await fetchJSON(`https://devapi.qweather.com/v7/weather/24h?location=${region.lon},${region.lat}&key=***}`);
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
    async fetch(region, date) {
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

/* ----------------------------- 主逻辑 ----------------------------- */

const { date, hour } = nowParts();
console.log(`运行时间：${date} ${hour}:00 北京时间`);

let hasAlert = false;

for (const region of REGIONS) {
  try {
    const results = await Promise.allSettled(sources.map(s => s.fetch(region, date)));
    const ok = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') ok.push(r.value);
      else console.warn(`[${region.id}] 源 ${sources[i].name} 不可用:`, r.reason?.message);
    });

    if (ok.length < MIN_SOURCES) {
      console.error(`[${region.id}] 可用源不足（${ok.length}个），需要至少${MIN_SOURCES}个，跳过`);
      continue;
    }

    // Cross-validation: at least MIN_SOURCES sources must agree on rain
    const votes = ok.filter(s => s.rainHours.size > 0);
    const shouldAlert = votes.length >= MIN_SOURCES;

    console.log(`[${region.id}] ${ok.length}个源，${votes.length}个预报有雨 -> ${shouldAlert ? '发送警报' : '无雨，不发送'}`);

    if (!shouldAlert) continue;

    // Determine rain hours (majority vote)
    const hourVotes = new Map();
    for (const s of ok) for (const h of s.rainHours) {
      if (!hourVotes.has(h)) hourVotes.set(h, []);
      hourVotes.get(h).push(s.name);
    }
    const confirmed = new Set(), possible = new Set();
    for (const [h, names] of hourVotes) {
      (names.length >= Math.min(MIN_SOURCES, ok.length) ? confirmed : possible).add(h);
    }

    const message = buildMessage(region, date, ok, confirmed, possible);
    await sendEmail(region.email, `☔ 天气警报 | ${region.name}`, message);
    console.log(`已发送警报邮件到 ${region.email}`);
    hasAlert = true;
  } catch (e) {
    console.error(`[${region.id}] 处理失败:`, e.stack || e);
  }
}

if (!hasAlert) {
  console.log('所有地区今日无雨，不发送邮件。');
}

/* ----------------------------- 工具函数 ----------------------------- */

function nowParts() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  });
  const p = {};
  for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

async function fetchJSON(url, opts = {}, timeoutMs = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': 'weather-bot/1.0', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

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
    `☔ 天气警报 | ${region.name}`,
    `今日（${date}）08:00–20:00 预计有雨`,
    confirmed.size ? `🌧 大概率降雨时段：${groupHours(confirmed)}` : '',
    possible.size ? `🌦 次要来源提示可能有雨：${groupHours(possible)}` : '',
    ``,
    `各来源预报：`,
    srcLine,
    ``,
    `---`,
    `数据来源：${okSources.map(s => s.name).join(' + ')}`,
  ].filter(Boolean).join('\n');
}

/* ----------------------------- SMTP 邮件 ----------------------------- */

async function sendEmail(to, subject, body) {
  const user = process.env.QQ_SMTP_USER;
  const pass = process.env.QQ_SMTP_PASS;
  if (!user || !pass) throw new Error('QQ_SMTP_USER 或 QQ_SMTP_PASS 未设置');

  return new Promise((resolve, reject) => {
    const socket = tls.connect(465, 'smtp.qq.com', { rejectUnauthorized: true }, () => {
      let step = 0;
      let buffer = '';
      let settled = false;

      const done = (err) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch {}
        if (err) reject(err); else resolve();
      };

      const write = (data) => socket.write(data + '\r\n');

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        while (buffer.includes('\r\n')) {
          const idx = buffer.indexOf('\r\n');
          const line = buffer.substring(0, idx);
          buffer = buffer.substring(idx + 2);

          const match = line.match(/^(\d{3}) (.*)/);
          if (!match) continue;

          const code = match[1];

          switch (step) {
            case 0:
              if (code === '220') { write('EHLO weather-bot'); step = 1; }
              break;
            case 1:
              if (code === '250') { write('AUTH LOGIN'); step = 2; }
              break;
            case 2:
              if (code === '334') { write(Buffer.from(user).toString('base64')); step = 3; }
              break;
            case 3:
              if (code === '334') { write(Buffer.from(pass).toString('base64')); step = 4; }
              break;
            case 4:
              if (code === '235') { write(`MAIL FROM:<${user}>`); step = 5; }
              else done(new Error(`SMTP 认证失败: ${line}`));
              break;
            case 5:
              if (code === '250') { write(`RCPT TO:<${to}>`); step = 6; }
              break;
            case 6:
              if (code === '250') { write('DATA'); step = 7; }
              break;
            case 7:
              if (code === '354') {
                const subjectEncoded = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
                const bodyEncoded = Buffer.from(body).toString('base64');
                const emailContent = [
                  `From: ${user}`,
                  `To: ${to}`,
                  `Subject: ${subjectEncoded}`,
                  'MIME-Version: 1.0',
                  'Content-Type: text/plain; charset=UTF-8',
                  'Content-Transfer-Encoding: base64',
                  '',
                  bodyEncoded,
                  '.',
                ].join('\r\n');
                write(emailContent);
                step = 8;
              }
              break;
            case 8:
              if (code === '250') { write('QUIT'); step = 9; }
              break;
            case 9:
              done();
              break;
          }
        }
      });

      socket.on('error', (err) => done(err));
      socket.setTimeout(30000, () => done(new Error('SMTP 连接超时')));
    });
  });
}
