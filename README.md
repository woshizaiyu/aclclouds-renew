# ACLClouds 自动续期 (Node.js + Playwright)

为 [ACLClouds](https://aclclouds.com) 免费 Discord Bot 服务器（Free 档，4 天一续）做的自动续期。API 预检 + 浏览器续期双链路，门控只跟 `can_renew` 布尔走。

## 原理

1. 预检：带登录态 cookie 调 `GET /api/client/servers/<id>`，读 `attributes.can_renew`。`false` 直接 SKIP，免开浏览器；`true` 才走浏览器。
2. 续期：注入登录态进服务器页，点 Renew（含确认弹窗），重读 detail 对 `expires_at` 变化验真。
3. 通知：Telegram 推送成功 / 无需续期 / 失败。

## Secrets

| 名称 | 必填 | 说明 | 示例 |
|---|---|---|---|
| `AUTH_STATE` | ✅*1 |  | 纯 `{...}` JSON |
| `ACL_EMAIL` | ✅*1 | 账号邮箱（降级登录用） | `your@email.com` |
| `ACL_PASSWORD` | ✅*1 | 账号密码 | `***` |
| `SERVER_PAGE_URL` | ✅ | 服务器页完整 URL，多个换行/逗号分隔 | `https://aclclouds.com/server/YOUR_SERVER_ID` |
| `SERVER_ID` | ❌ | 仅服务器 ID，自动拼接 | `YOUR_SERVER_ID` |
| `GH_TOKEN` | ❌ | 回写 `AUTH_STATE` 用（classic PAT） | `ghp_xxx` |
| `TG_BOT_TOKEN` | ❌ | Telegram Bot Token | `123456:AAA-xxx` |
| `TG_CHAT_ID` | ❌ | 接收通知 Chat ID | `123456789` |
| `NODE_LINK` | ❌ | 代理节点（vless/hy2/vmess/trojan/tuic/anytls/socks5），配了则 workflow 起 sing-box，走 `socks5://127.0.0.1:1080`；不通自动直连 | `vless://...` |

> *1：`AUTH_STATE` 与 `ACL_EMAIL+ACL_PASSWORD` 二选一，优先 `AUTH_STATE`。
>
> 取法：打开 `agentscribe-playwright-*.js`，复制 `storageState: { "cookies": [...6 个...], "origins": [...] }` 整个 `{...}`（去掉头上 `storageState:` 前缀），粘贴为 Secret 值。脚本也接受 base64 后的值。
> 关键 cookie 共 6 个，缺一不可：
>
> | Cookie | 作用 | 备注 |
> |---|---|---|
> | `remember_web_*` | 登录身份（httpOnly，一年有效期） | 掉它等于未登录 |
> | `__Host-aclclouds_session` | 会话（httpOnly） | 掉它会 401 |
> | `XSRF-TOKEN` | CSRF 票据，脚本解码后放 `X-XSRF-TOKEN` 请求头 | 掉它会 419 |
> | `_ga` / `_ga_*` / `acl_consent` | 统计与 consent，可有可无 | 建议保留原文 |
>
> `AUTH_STATE` 失效信号：日志出现 `登录态失效` / 预检 `HTTP 401/419`，重录一次更新 Secret 即可。

## 部署

1. 新建 GitHub 仓库，把本目录文件推上去（勿提交录制文件，见 `.gitignore`）。
2. Settings → Secrets and variables → Actions 配好上表 Secrets。
3. Actions 启用工作流，手动跑一次看日志。巡检每 12 小时一次（`renew.yml` cron）。

## 本地调试

```bash
npm install
node --check renew.js
set AUTH_STATE={"cookies":[],"origins":[]}
set SERVER_PAGE_URL=https://aclclouds.com/server/YOUR_SERVER_ID
set DRY_RUN=true
set HEADLESS=false
npm start
```

## 已知缺口

- 真实续期按钮选择器待 `can_renew=true` 时补录确认，当前文案泛匹配；若出现 `NO_BUTTON`，贴运行截图+补录制给我。
- 账密登录为 best-effort，登录页结构未完全确认，优先用 `AUTH_STATE`。
