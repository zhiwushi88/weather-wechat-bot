# weather-wechat-bot 交接文档

> 最后更新：2026-11-02 · 交付状态：✅ 代码完成并实测通过，待部署

## 一、项目是干什么的

无人值守降雨提醒机器人，部署后完全免费运行：

- **监测点**：贵阳·花溪区（26.4306, 106.6703）、福州·闽侯县上街镇（26.0830, 119.2090）
- **监测窗口**：每天北京时间 08:00–20:00，每小时检查一次
- **多源防误报**：Open-Meteo（免密钥）+ 和风天气 + OpenWeatherMap，**≥2 个来源一致预报有雨才推送**；分歧时段在消息里区分"大概率降雨 / 可能有雨"
- **静默策略**：不会下雨就不推送；同一天同一降雨时段只推一次，时段变化才补报（KV / cache 去重）
- **推送渠道**：企业微信群机器人 或 Server酱（个人微信），二选一或都配

## 二、文件夹结构（本文件夹 = 仓库根目录）

```
weather-wechat-bot/
├── .github/workflows/
│   ├── weather.yml        # GitHub Actions 版：定时调度（北京时间 8-20 点每小时）
│   └── keepalive.yml      # 每月自动空提交，防止仓库闲置被暂停定时任务
├── src/index.js           # Cloudflare Workers 版主脚本
├── bot.mjs                # GitHub Actions 版脚本（Node ≥18，逻辑与 Workers 版一致）
├── wrangler.toml          # Cloudflare 配置（cron 触发器 + KV）
├── package.json           # Cloudflare 部署依赖（wrangler）
├── README.md              # Cloudflare 版详细部署说明
└── HANDOVER.md            # 本文档
```

**同一个仓库可以同时支持两种部署，互为备份，都免费。**

## 三、部署方式 A：GitHub Actions（推荐，零平台依赖）

1. 注册/登录 GitHub → 右上角 + → New repository → 名字任意（如 `weather-wechat-bot`），选 **Public**，不要勾选任何初始化选项
2. 把本文件夹**全部内容**推上去：
   ```bash
   cd weather-wechat-bot
   git init && git add . && git commit -m "init: weather-wechat-bot"
   git remote add origin https://github.com/<你的用户名>/weather-wechat-bot.git
   git branch -M main && git push -u origin main
   ```
3. 仓库 → Settings → Secrets and variables → Actions → New repository secret，添加（至少一个推送渠道）：
   | Secret 名 | 值 | 必填 |
   |---|---|---|
   | `WECOM_WEBHOOK` | 企业微信群机器人 Webhook 地址（群右键→添加群机器人） | 二选一 |
   | `SERVERCHAN_KEY` | [sct.ftqq.com](https://sct.ftqq.com) 微信登录后复制的 SendKey | 二选一 |
   | `QWEATHER_KEY` | 和风天气免费 Key（[dev.qweather.com](https://dev.qweather.com)），增加第三投票源 | 可选 |
   | `OWM_KEY` | [openweathermap.org](https://openweathermap.org/api) 免费 Key | 可选 |
4. 仓库 → Actions → weather-bot → Run workflow 手动跑一次验证；跑完看日志确认
5. 完成。之后每天 8–20 点自动运行（注意 GitHub 定时可能延迟 5~30 分钟，属正常）

## 四、部署方式 B：Cloudflare Workers（触发更准点）

```bash
npm install
npx wrangler login
npx wrangler kv namespace create KV      # 把返回的 id 填进 wrangler.toml
npx wrangler secret put WECOM_WEBHOOK     # 或 SERVERCHAN_KEY
npx wrangler secret put QWEATHER_KEY      # 可选
npx wrangler secret put OWM_KEY           # 可选
npx wrangler deploy
```
验证：`npm run tail` 看日志；`curl https://weather-wechat-bot.<子域>.workers.dev/run` 手动触发。

## 五、已验证事项（2026-11-02 实测）

- ✅ Open-Meteo 取数正常：当天花溪 11–14 时、上街 9–12 时被正确判为降雨时段
- ✅ 投票逻辑、去重状态读写、消息组装、语法检查均通过
- ✅ 未配置推送渠道时会明确报错提示（不会静默失败）
- ⚠️ 和风/OWM 源需你自己的 Key 后才能参与投票（免费申请，见上表）

## 六、日常维护

- 基本免维护。可定期到 Actions 页面查看运行记录
- 调整灵敏度：改 `MIN_SOURCES`（默认 2，越大越保守）、`RAIN_PROB_THRESHOLD`（默认 50%）
- 改监测点/加城市：编辑两个脚本顶部的 `REGIONS` 数组
- 推送不响了先查：Actions 日志 → Secrets 是否还在 → Webhook 是否被机器人移出群
