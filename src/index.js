/**
 * weather-wechat-bot
 * Cloudflare Workers 定时天气监测：
 *  - 每天 08:00–20:00（北京时间）每小时检查一次
 *  - 两个监测点：贵阳·花溪区 / 福州·闽侯县上街镇
 *  - 多个权威天气源交叉验证（Open-Meteo / 和风天气 / OpenWeatherMap）
 *  - 可能降雨才推送微信（企业微信群机器人 或 Server酱），否则静默
 *  - 同一天同一降雨时段不重复打扰，时段变化才补报
 */

const TIMEZONE = 'Asia/Shanghai';
const WINDOW_START = 8;   // 北京时间 08:00 开始
const WINDOW_END = 20;    // 北京时间 20:00 结束（检查 8..19 这 12 个整点时段）

const REGIONS = [
  { id: 'huaxi',    name: '贵阳·花溪区',       lat: 26.4306, lon: 106.6703 },
  { id: 'shangjie', name: '福州·闽侯县上街镇', lat: 26.0830, lon: 119.2090 },
];

// Open-Meteo WMO 天气码中代表降雨/雷雨的码
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      // 手动触发（可选保护：设置 SECRET 里的 ADMIN_TOKEN 后需 ?token=xxx）
      if (env.ADMIN_TOKEN && url.searchParams.get('token') !== env.ADMIN_TOKEN) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      ctx.waitUntil(runCheck(env));
      return json({ ok: true, msg: 'check started, see logs via `wrangler tail`' });
    }
    return json({ ok: true, service: 'weather-wechat-bot', time: new Date().toISOString() });
  },
};

/* ----------------------------- 主流程 ----------------------------- */

async function runCheck(env) {
  const { date, hour } = nowParts();
  // cron 每小时触发一次，保险起见再过滤窗口
  if (hour < WINDOW_START || hour > WINDOW_END) return;

  const sources = listSources(env);
  if (sources.length === 0) {
    console.error('未配置任何天气源（至少 Open-Meteo 无需密钥，检查代码）');
    return;
  }

  for (const region of REGIONS) {
    try {
      await checkRegion(region, sources, env, date, hour);
    } catch (e) {
      console.error(`[${region.id}] 检查失败:`, e.stack || e);
    }
  }
}

async function checkRegion(region, sources, env, date, hour) {
  // 并发请求所有可用源，单个源失败不影响整体
  const results = await Promise.allSettled(sources.map(s => s.fetch(region, date)));
  const ok = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value && r.value.ok) ok.push(r.value);
    else console.warn(`[${region.id}] 源 ${sources[i].name} 不可用:`,
      r.status === 'rejected' ? (r.reason && r.reason.message) : 'bad data');
  });
  if (ok.length === 0) {
    console.error(`[${region.id}] 所有天气源均失败，本次跳过（下个小时会重试）`);
    return;
  }

  // 每个源给出"预计降雨的时段"集合
  const votes = ok.filter(s => s.rainHours.size > 0);
  const minSources = num(env.MIN_SOURCES, 2);
  const threshold = num(env.RAIN_PROB_THRESHOLD, 50);

  let shouldNotify, reason;
  if (votes.length >= minSources) {
    shouldNotify = true;
    reason = `${votes.length}/${ok.length} 个来源一致预报有雨`;
  } else if (votes.length === ok.length && votes.length === 1 && ok.length === 1) {
    // 只配置了一个源：单独降级判定，要求置信度足够高
    const s = ok[0];
    const maxProb = Math.max(0, ...[...s.probByHour.values()]);
    if (maxProb >= Math.max(threshold, 60)) {
      shouldNotify = true;
      reason = `仅 ${s.name} 可用（其他源未配置/失败），其降雨概率 ${maxProb}%`;
    } else shouldNotify = false;
  } else {
    shouldNotify = false;
    reason = '';
  }
  console.log(`[${region.id}] ${date} ${hour}时 votes=${votes.length}/${ok.length} -> ${shouldNotify ? '通知' : '静默'} ${reason}`);

  if (!shouldNotify) return;

  // 合并所有源给出的降雨时段（取交集更严格？取并集更保守——这里取"至少 2 源都报雨"的时段，单源也报雨的时段标注"可能有雨"）
  const confirmed = new Set();   // >=minSources 源都报雨
  const possible = new Set();    // 仅 1 源报雨
  const hourVotes = new Map();   // hour -> [sourceNames]
  for (const s of ok) {
    for (const h of s.rainHours) {
      if (!hourVotes.has(h)) hourVotes.set(h, []);
      hourVotes.get(h).push(s.name);
    }
  }
  for (const [h, names] of hourVotes) {
    if (names.length >= Math.min(minSources, ok.length)) confirmed.add(h);
    else possible.add(h);
  }

  // 去重：同一时段已通知过则不再打扰（KvNamespace，可选但强烈建议绑定）
  const notified = await getNotified(env, region.id, date);
  const newConfirmed = [...confirmed].filter(h => !notified.confirmed.includes(h));
  const newPossible = [...possible].filter(h => !notified.possible.includes(h));
  if (newConfirmed.length === 0 && newPossible.length === 0) {
    console.log(`[${region.id}] 无新增降雨时段，不重复通知`);
    return;
  }
  notified.confirmed.push(...newConfirmed);
  notified.possible.push(...newPossible);
  await setNotified(env, region.id, date, notified);

  const message = buildMessage(region, date, ok, hourVotes, confirmed, possible);
  await notify(env, message);
}

/* ----------------------------- 天气源 ----------------------------- */

function listSources(env) {
  const threshold = num(env.RAIN_PROB_THRESHOLD, 50);
  const sources = [
    {
      name: 'Open-Meteo',
      // 免费无密钥，ECMWF/GFS 等多模式数据
      async fetch(region, date) {
        const url = 'https://api.open-meteo.com/v1/forecast'
          + `?latitude=${region.lat}&longitude=${region.lon}`
          + '&hourly=precipitation_probability,precipitation,weather_code'
          + `&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=2`;
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
          if (prob >= threshold || mm > 0.1 || RAIN_CODES.has(code)) rainHours.add(h);
        });
        return { name: this.name, ok: true, rainHours, probByHour };
      },
    },
  ];
  if (env.QWEATHER_KEY) {
    sources.push({
      name: '和风天气',
      // 中国气象局官方授权数据，免费开发版即可
      async fetch(region, date) {
        const host = env.QWEATHER_HOST || 'devapi.qweather.com';
        const d = await fetchJSON(`https://${host}/v7/weather/24h?location=${region.lon},${region.lat}&key=${env.QWEATHER_KEY}`);
        if (String(d.code) !== '200') throw new Error(`qweather code=${d.code}`);
        const rainHours = new Set(), probByHour = new Map();
        for (const it of d.hourly || []) {
          if (!String(it.fxTime).startsWith(date)) continue;
          const h = Number(String(it.fxTime).slice(11, 13));
          if (h < WINDOW_START || h >= WINDOW_END) continue;
          const pop = Number(it.pop ?? 0);
          probByHour.set(h, pop);
          if (/[雨雷]/.test(it.text) || pop >= threshold) rainHours.add(h);
        }
        return { name: this.name, ok: true, rainHours, probByHour };
      },
    });
  }
  if (env.OWM_KEY) {
    sources.push({
      name: 'OpenWeatherMap',
      async fetch(region, date) {
        const d = await fetchJSON(`https://api.openweathermap.org/data/2.5/forecast?lat=${region.lat}&lon=${region.lon}&appid=${env.OWM_KEY}&units=metric`);
        const rainHours = new Set(), probByHour = new Map();
        // OWM 返回 UTC 时间戳的 3 小时步长数据，转北京时间后再落到各整点
        for (const it of d.list || []) {
          const local = new Date(it.dt * 1000 + 8 * 3600 * 1000);
          const ds = local.toISOString().slice(0, 10), h = local.getUTCHours();
          if (ds !== date || h < WINDOW_START || h >= WINDOW_END) continue;
          const pop = Math.round((it.pop ?? 0) * 100);
          probByHour.set(h, pop);
          if (pop >= threshold || (it.rain && it.rain['3h'] > 0.1)) rainHours.add(h);
        }
        return { name: this.name, ok: true, rainHours, probByHour };
      },
    });
  }
  return sources;
}

/* ----------------------------- 消息与推送 ----------------------------- */

function buildMessage(region, date, okSources, hourVotes, confirmed, possible) {
  const fmtH = h => `${String(h).padStart(2, '0')}时`;
  const groupHours = (set) => {
    const arr = [...set].sort((a, b) => a - b);
    const out = [];
    let s = arr[0], p = arr[0];
    for (const h of arr.slice(1)) {
      if (h === p + 1) { p = h; continue; }
      out.push(s === p ? fmtH(s) : `${fmtH(s)}–${fmtH(p)}`);
      s = p = h;
    }
    if (s !== undefined) out.push(s === p ? fmtH(s) : `${fmtH(s)}–${fmtH(p)}`);
    return out.join('、') || '无';
  };
  const srcLine = okSources
    .map(s => {
      const hours = [...s.rainHours].sort((a, b) => a - b);
      const tag = hours.length
        ? hours.map(h => `${fmtH(h)}(${s.probByHour.get(h) ?? '?'}%)`).join(' ')
        : '无雨';
      return `- ${s.name}：${tag}`;
    })
    .join('\n');
  const confirmedLine = confirmed.size ? `🌧 **大概率降雨时段：${groupHours(confirmed)}**` : '';
  const possibleLine = possible.size ? `🌦 次要来源提示可能有雨：${groupHours(possible)}` : '';
  return [
    `☔ **天气提醒 | ${region.name}**`,
    `今日（${date}）08:00–20:00 预计有雨`,
    confirmedLine,
    possibleLine,
    `**各来源预报：**`,
    srcLine,
    `_来自 weather-wechat-bot · ${nowParts().hour}时更新_`,
  ].filter(Boolean).join('\n');
}

async function notify(env, message) {
  const jobs = [];
  if (env.WECOM_WEBHOOK) {
    jobs.push(fetchJSON(env.WECOM_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: message } }),
    }).then(r => { if (r.errcode !== 0) throw new Error(`wecom errcode=${r.errcode}`); console.log('已推送到企业微信'); }));
  }
  if (env.SERVERCHAN_KEY) {
    // Server酱：推送到个人微信（服务号「方糖」）
    jobs.push(fetchJSON(`https://sctapi.ftqq.com/${env.SERVERCHAN_KEY}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `title=${encodeURIComponent('☔ 天气提醒：今日可能有雨')}&desp=${encodeURIComponent(message)}`,
    }));
  }
  if (jobs.length === 0) {
    console.error('未配置任何推送渠道！请在 Secrets 中设置 WECOM_WEBHOOK 或 SERVERCHAN_KEY');
    return;
  }
  const rs = await Promise.allSettled(jobs);
  rs.filter(r => r.status === 'rejected').forEach(r => console.error('推送失败:', r.reason));
}

/* ----------------------------- KV 去重 ----------------------------- */

async function getNotified(env, regionId, date) {
  if (!env.KV) return { confirmed: [], possible: [] };
  try {
    const v = await env.KV.get(`notified:${regionId}:${date}`, 'json');
    return v || { confirmed: [], possible: [] };
  } catch { return { confirmed: [], possible: [] }; }
}

async function setNotified(env, regionId, date, v) {
  if (!env.KV) return;
  try {
    // 当天 24 点后自动过期，无需清理
    await env.KV.put(`notified:${regionId}:${date}`, JSON.stringify(v), { expirationTtl: 86400 * 2 });
  } catch (e) { console.error('KV 写入失败:', e); }
}

/* ----------------------------- 工具 ----------------------------- */

function nowParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  });
  const p = {};
  for (const x of fmt.formatToParts(new Date())) p[x.type] = x.value;
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

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
