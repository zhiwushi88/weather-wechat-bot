# weather-wechat-bot

部署在 Cloudflare Workers 上的无人值守降雨提醒机器人：

- **监测点**：贵州省贵阳市花溪区 / 福建省福州市闽侯县上街镇
- **监测窗口**：每天北京时间 08:00–20:00（12 小时），每小时整点检查一次
- **多源交叉验证**：默认 Open-Meteo（免密钥）+ 和风天气（中国气象局授权）+ OpenWeatherMap，**至少 2 个来源一致预报有雨才推送**，避免单一来源误报；时段意见不一致时会在消息里分开标注"大概率降雨"与"可能有雨"
- **静默策略**：不会下雨就完全不推送；同一天的同一降雨时段只推一次，降雨时段变化才补报
- **无间断**：Workers Cron 由 Cloudflare 全球网络调度，无需自己维护服务器；单个天气源请求失败不影响整体（剩余源投票），全部失败则下个小时自动重试

## 一、配置推送渠道（二选一或都配）

**企业微信群机器人（推荐，可发群）**：微信群右键 → 添加群机器人 → 复制 Webhook 地址（形如 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx`）。

**Server酱（推送到个人微信）**：在 [sct.ftqq.com](https://sct.ftqq.com) 用微信登录后复制 SendKey。

## 二、部署步骤

```bash
cd weather-wechat-bot
npm install
npx wrangler login

# 1. 创建 KV 命名空间，把返回的 id 填到 wrangler.toml 的 REPLACE_WITH_YOUR_KV_ID
npx wrangler kv namespace create KV

# 2. 设置密钥（按需，至少配一个推送渠道；和风/OWM 的 key 可选，配了才有第三个源参与投票）
npx wrangler secret put WECOM_WEBHOOK      # 企业微信机器人 Webhook
npx wrangler secret put SERVERCHAN_KEY     # Server酱 SendKey（可选）
npx wrangler secret put QWEATHER_KEY       # 和风天气 Key（可选）
npx wrangler secret put QWEATHER_HOST      # 免费版填 devapi.qweather.com（可选）
npx wrangler secret put OWM_KEY            # OpenWeatherMap Key（可选）
npx wrangler secret put ADMIN_TOKEN        # 手动触发接口的口令（可选）

# 3. 部署
npm run deploy
```

部署后 Worker 即 7×24 无人值守运行。验证：

```bash
# 实时查看日志
npm run tail

# 手动触发一次完整检查（会真实走一遍投票与推送流程）
curl "https://weather-wechat-bot.<你的子域>.workers.dev/run?token=<ADMIN_TOKEN>"
```

## 三、可调参数（wrangler.toml [vars]）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MIN_SOURCES` | 2 | 至少几个源一致报雨才推送 |
| `RAIN_PROB_THRESHOLD` | 50 | 单小时降雨概率达到多少 % 判为"有雨" |

## 四、推送效果示例

```
☔ 天气提醒 | 贵阳·花溪区
今日（2026-11-02）08:00–20:00 预计有雨
🌧 大概率降雨时段：11时–13时、15时
各来源预报：
- Open-Meteo：11时(78%) 12时(85%) 13时(80%) 15时(55%)
- 和风天气：11时(70%) 12时(75%) 13时(70%)
- OpenWeatherMap：12时(80%) 13时(66%)
```

## 监测点坐标

| 地点 | 纬度 | 经度 |
|---|---|---|
| 贵阳·花溪区 | 26.4306 | 106.6703 |
| 福州·闽侯县上街镇 | 26.0830 | 119.2090 |
