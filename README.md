

## Secrets

| 名称 | 必填 | 说明 | 示例 |
|---|---|---|---|
| `AUTH_STATE` | ✅*1 |  | 纯 `{...}` JSON |
| `ACL_EMAIL` | ✅*1 | 账号邮箱（降级登录用） | `your@email.com` |
| `ACL_PASSWORD` | ✅*1 | 账号密码 | `***` |
| `SERVER_PAGE_URL` | ✅ | 服务器页完整 URL，多个换行/逗号分隔 | `https://aclclouds.com/server/YOUR_SERVER_ID` |
| `SERVER_ID` | ❌ | 仅服务器 ID，自动拼接 | `YOUR_SERVER_ID` |
| `GH_TOKEN` | ❌ | 回写 `AUTH_STATE` + cron 自我调度用（classic PAT，需勾 `repo` + `workflow`；默认 `GITHUB_TOKEN` 推不了 workflow 文件） | `ghp_xxx` |
| `TG_BOT_TOKEN` | ❌ | Telegram Bot Token | `123456:AAA-xxx` |
| `TG_CHAT_ID` | ❌ | 接收通知 Chat ID | `123456789` |
| `NODE_LINK` | ❌ | 代理节点（vless/hy2/vmess/trojan/tuic/anytls/socks5），配了则 workflow 起 sing-box，走 `socks5://127.0.0.1:1080`；不通自动直连 | `vless://...` |

