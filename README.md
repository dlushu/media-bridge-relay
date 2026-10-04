# media-bridge-relay

[媒体桥面板](https://github.com/dlushu/media-bridge-panel)的**外部字节中继**（Cloudflare Worker）：
面板把上游地址、请求头、搬运参数全部 302 到这里，字节由 Cloudflare 边缘搬，面板只发 302。

## 面板 302 过来的参数

```
?u=<base64url(上游地址)>&h=<base64url(JSON 请求头)>&s=<HMAC-SHA256>&threads=&chunkKB=
```

| 参数 | 说明 |
|---|---|
| `u` | 上游取流地址（base64url，必填） |
| `h` | 发给上游的请求头 JSON（Cookie / UA / Referer…），没头不带 |
| `s` | HMAC-SHA256 签名（配了 `SECRET` 才验，对不上 403） |
| `threads` / `chunkKB` | 分块并发的路数与每块 KB —— **面板「播放中继设置」传的**，面板设置页改了就跟着变；不带 = 单连接透传 |

行为与面板内置中继同一套口径：带 `threads/chunkKB` → 探总长、有界 Range 切块并发；不带 → 单连接原样透传。

## 部署

```bash
npm i -g wrangler
wrangler login
wrangler deploy
```

部署完输出形如 `https://media-bridge-relay.<你的子域>.workers.dev` —— 把它填进面板
「面板设置 → 播放中继设置 → 外部字节代理 URL」。

## 可选：设共享密钥（推荐）

不设密钥，任何知道你 Worker 地址的人都能拿来当开放代理用。设了之后面板侧填同一个值，302 链接会带签名：

```bash
wrangler secret put SECRET
```

面板侧填进「外部字节代理签名密钥」即可，两边不用同步部署。

## 限额提醒

- **单个请求并发硬封顶 12 路**（实测 ≥13 路时多余连接被掐、重试打满子请求预算 → 整个请求被杀）；面板里填再大也会压平到 12。12 路有界 Range 实测夸克 ~4.3MB/s。
- CF **免费版单个请求最多 50 个子请求**：探针 1 发 + 每块每次重试都算，正常约 45 块（@512KB ≈ 22MB），搬完正常收尾，播放器拿断点 Range 重连续传（标准行为），能接着播。付费版上限 1000。
