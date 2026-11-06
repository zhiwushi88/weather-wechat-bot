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
5. 完成。之后每天 8–20 点自动运行（注意 GitHub 免费版 schedule 实测会迟到约 4 小时，
   本仓库已做 cron 补偿，详见「五之二」）

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

## 五之二、GitHub schedule 迟到问题与补偿（2026-11-06 实测）

**结论：GitHub 免费版的 `schedule` 在本仓库上稳定迟到约 4 小时，不是配置错误，调不了。**

实测数据（API 拉的 `created_at`，北京时间）：

| 日期 | 计划 | 实际 | 迟到 |
|---|---|---|---|
| 11-03 | 07:30 | 11:58 | +4h28m |
| 11-04 | 07:30 | 11:07 | +3h37m |
| 11-05 | 07:30 | 11:38 | +4h08m |
| 11-06 | 07:30 | 11:35 | +4h05m |

平均 +4h05m。run 的 `created_at` 与 `run_started_at` 只差 1~12 秒，**说明不是排队等机器，
是 GitHub 调度器本身把触发时间推后了**。GitHub 状态页当时全部 operational，不是故障。

反向验证：手动 `workflow_dispatch` 发出 → 6 秒后 run 创建。**主动触发通道准点，只有 `schedule` 会延迟。**

### 当前采用：cron 提前补偿（方案 B）

`cron: "25 19 * * *"`（UTC 19:25 = 北京 03:25），加上约 4h05m 延迟，落在北京 07:30 前后。

**风险**：延迟量不是常数（波动 ±25 分钟），且若 GitHub 哪天调度恢复正常，邮件会在凌晨 03:25 发出。

### 长期方案：方案 A（尚未实施）

用外部免费定时服务（如 cron-job.org）每天 07:30 调 GitHub API 触发 `workflow_dispatch`。
实测触发到开跑 6 秒。需要一个 fine-grained PAT（仅本仓库 Actions:write 权限），
token 会存放在第三方侧。用户 2026-11-06 选择先走方案 B 止血。

### 已知连带问题

跑得晚时，邮件正文仍写“今日 08:00–20:00 预计有雨”，会把已过去的时段算进去。
时间修正后自然消失。若要根治，可在 `bot.mjs` 里把 `WINDOW_START` 改为 `max(8, 当前小时)`。

## 六、日常维护

- 基本免维护。可定期到 Actions 页面查看运行记录
- 调整灵敏度：改 `MIN_SOURCES`（默认 2，越大越保守）、`RAIN_PROB_THRESHOLD`（默认 50%）
- 改监测点/加城市：编辑两个脚本顶部的 `REGIONS` 数组
- 推送不响了先查：Actions 日志 → Secrets 是否还在 → Webhook 是否被机器人移出群
