# AGENTS.md — aclclouds-renew

ACLClouds（https://aclclouds.com）免费 Discord Bot（Free 档，4 天一续）自动续期。
Node.js 18 + Playwright + GitHub Actions。远端：`https://github.com/woshizaiyu/aclclouds-renew.git`（分支 main）。

## 目录

- `renew.js` — 唯一脚本：API 预检 + 浏览器续期 + TG 报告
- `.github/workflows/renew.yml` — CI：巡检 `10 */12 * * *`，无 npm cache（无 lockfile）
- `package.json` / `README.md` / `.gitignore`
- 本地仅有（绝不提交）：`agentscribe-*.js/json`（录制，含真实 cookie）、`slim-storage-state.json`（2.2KB 精简登录态）、`screenshots/`

## 核心设计（改代码前必读）

1. 门控只跟 `can_renew` 布尔走：`GET /api/client/servers/<id>` → `attributes.can_renew`。`false`=SKIP 免开浏览器，`true`=走浏览器。`expires_at` 仅展示与复核，不参与门控。
2. 认证是 session-cookie（Laravel 系）：`remember_web_*` + `__Host-aclclouds_session` + `XSRF-TOKEN` 三件套；API 请求头 `X-XSRF-TOKEN = decodeURIComponent(XSRF cookie)`，另带 `X-Requested-With: XMLHttpRequest`。见 `apiServerDetail`（请求头复刻自录制 session 461bb59b）。
3. 真实续期按钮选择器未知（录制时 `can_renew=false` 没点到），`renewOneServer` 用文案泛匹配 Renew/Confirm/Yes。若报 `NO_BUTTON`，需 `can_renew=true` 时补录制。
4. 代理：`NODE_LINK` → workflow 起 sing-box → 脚本读 `IS_PROXY`/`PROXY_SERVER`，TCP 探测 1080，不通自动直连。不配即直连。

## 常用命令

```bash
npm install
node --check renew.js
# 演练（不点击）：DRY_RUN=true HEADLESS=false npm start
```

## 环境变量

`AUTH_STATE`（storageState 纯 JSON，推荐用 `slim-storage-state.json`，localStorage 已清空）与 `ACL_EMAIL+ACL_PASSWORD` 二选一；`SERVER_PAGE_URL`/`SERVER_ID`；`GH_TOKEN+AUTO_UPDATE_STATE` 回写登录态；`TG_BOT_TOKEN`/`TG_CHAT_ID`；`NODE_LINK` 可选。

## CI 铁律（踩过坑）

- `if:` 里禁用 `secrets` 上下文（会 Invalid workflow file），secret 判空放 `run:` 里或让脚本兜底。
- `setup-node` 不要开 `cache: npm`（本仓无 lockfile，`npm ci` 会挂），用 `npm install`。
- push 前先 `git pull --rebase`，远端可能有网页端改动。
- 录制/登录态文件永远不进仓库（`.gitignore` 已覆盖 `agentscribe-*`、`slim-storage-state.json`、`storage-state*.json`）。

## 上游约定（佬王 eooce 系，已验证）

- sing-box 同源：workflow 用 `https://main.ssss.nyc.mn/setup_proxy.sh`，与 `eooce/Auto-Renew-HidenCloud` 一字不差；成功时写 `GITHUB_ENV`（`IS_PROXY`/`PROXY_SERVER`），脚本只读这两个 env，不自建代理变量。
- TG 通知风格对齐 `eooce/Auto-Renew-HidenCloud` 的 `send_telegram_notification`：标题 `🎰 <平台> 续期报告` + 状态行 + `📧 账号`（邮箱前后2位脱敏）+ `⏱ 续期前到期时间` + `⏱ 续期后到期时间`，`parse_mode: HTML` 直发。`oyz8/HidenCloud` 已归档（作者指路 eooce 版），不要再参考旧仓。
- API 预检是本仓自研（上游纯浏览器、无此环节），动门控逻辑时同步更新本节。
