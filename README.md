# media-bridge-relay

[媒体桥面板](https://github.com/dlushu/media-bridge-panel)的**外部字节中继**（Cloudflare Worker）：
面板把上游地址、请求头、搬运参数全部 302 到这里，字节由 Cloudflare 边缘搬，面板只发 302。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dlushu/media-bridge-relay)

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

**一键部署（推荐）**：点上面的「Deploy to Cloudflare」按钮，按提示授权 GitHub 并创建仓库副本即可
（Cloudflare 会自动构建并持续部署后续 push）。

**手动部署**：

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com) → 左侧 **Workers 和 Pages** →
   **创建** → **Worker**，起个名字 → **部署**（先得到一个默认 Worker）。
2. 进入这个 Worker → **编辑代码**，把本仓库 [`src/worker.js`](src/worker.js) 的全部内容
   粘贴进去覆盖默认代码 → **部署**。
3. 部署完地址形如 `https://<你起的名字>.<你的子域>.workers.dev` —— 把它填进面板
   「面板设置 → 播放中继设置」，并打开「外转到外部字节代理」开关。

## 可选：设共享密钥（推荐）

不设密钥，任何知道你 Worker 地址的人都能拿来当开放代理用。设了之后面板侧填同一个值，302 链接会带签名：

1. Worker 页 → **设置** → **变量和机密**（部分账号显示为「运行时变量和密钥」）。
2. **添加**：类型选 **机密（Secret）**，名称填 `SECRET`，值填你的密钥 → 保存。
3. **重新部署一次 Worker** 让变量生效（只加变量不部署 = 不生效）。

面板侧把同一个值填进「外部代理签名密钥」即可，两边不用同步部署。

## 限额提醒

- **单个请求并发硬封顶 12 路**（实测 ≥13 路时多余连接被掐、重试打满子请求预算 → 整个请求被杀）；面板里填再大也会压平到 12。12 路有界 Range 实测夸克 ~4.3MB/s。
- CF **免费版单个请求最多 50 个子请求**：探针 1 发 + 每块每次重试都算。每次响应**只声明它真能搬完的那一段**（`Content-Length` / `Content-Range` 与实际吐出字节严格一致），搬完按标准 206 收尾，播放器按 `Content-Range` 续传下一段 —— 不会再出现「播到固定位置连接超时」。为给重试留余量，单次约 30 块（@512KB ≈ 15MB，@2048KB ≈ 57MB）：**分块 KB 调大 = 单次搬得更多、重连更少**。付费版上限 1000。
