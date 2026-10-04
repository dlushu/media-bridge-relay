/**
 * media-bridge 字节中继 Worker —— 面板外转（302）过来的取流端。
 *
 * 面板把上游地址、请求头、搬运参数全部放在 query 上（无状态，重启/换机都不影响）：
 *
 *   ?u=<base64url(上游地址)>&h=<base64url(JSON 请求头)>&s=<HMAC-SHA256>&threads=&chunkKB=
 *
 *   · u  上游取流地址（必填）
 *   · h  发给上游的请求头 JSON（Cookie / UA / Referer…，面板代持的那串），没头不带
 *   · s  HMAC-SHA256(forwardSecret, u + (h ? '.' + h : ''))，配了 SECRET 才验，对不上 403
 *   · threads / chunkKB   分块并发的路数与每块大小 —— **面板「播放中继设置」传过来的**：
 *     面板设置页改「并发路数 / 分块 KB」就跟着变；不带这俩（面板关了并发或直接访问）→ 单连接透传
 *
 * 行为两条（与面板 relayBytes 同一套口径）：
 *   · 分块并发：先探一发有界 Range 拿总长 → 按块切、threads 路在飞、按序吐；
 *     上游 CDN 对开放式 `bytes=0-` 实测 ~0.1MB/s、对有界 Range ~3.5MB/s —— 切块就是
 *     为了让每一发都变成有界 Range。
 *   · 单连接透传：客户端的 Range 原样带给上游，响应流式回，不碰字节形状。
 *
 * ⚠️ 子请求预算：**免费版单个 Worker 请求最多 50 个子请求**。分块模式下探 1 发 + 最多
 *    47 块，搬完就正常收尾 —— 播放器会拿断点 Range 重连续传（标准行为），能接着播。
 *    付费版上限 1000，基本用不完。
 */

/** 探一发先要多少字节（只为拿 `content-range` 里的总长，读完即断） */
const PROBE_BYTES = 1024;
/** 单请求子请求预算（免费版 50，留点余量） */
const MAX_SUBREQUESTS = 48;
/** 单发子请求的超时（客户端在等这一跳） */
const TIMEOUT_MS = 15000;

/** base64url → 字符串（Cloudflare 环境自带 atob） */
function fromB64Url(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** HMAC-SHA256 → base64url（与面板 `Buffer.createHmac('sha256').digest('base64url')` 同一算法） */
async function hmacB64Url(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  let bin = '';
  for (const b of new Uint8Array(mac)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 客户端 Range → {start, end(闭区间, Infinity 可)}；认不出回 null */
function parseRange(h) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') return { suffix: Number(m[2]) };
  return { start: Number(m[1]), end: m[2] === '' ? Infinity : Number(m[2]) };
}

/** 把客户端 Range 落到已知总长上（`bytes=-N` 要总长才算得出起点） */
function resolveRange(want, total) {
  if (!want) return { start: 0, end: total - 1, ranged: false };
  if (want.suffix !== undefined) {
    const n = Math.max(0, Math.min(want.suffix, total));
    return { start: total - n, end: total - 1, ranged: true };
  }
  return {
    start: Math.min(want.start, total),
    end: want.end === Infinity ? total - 1 : Math.min(want.end, total - 1),
    ranged: true,
  };
}

/** 带超时地取上游 */
function fetchChunk(url, headers, start, end, extraHeaders) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, {
    headers: Object.assign({}, headers, { Range: `bytes=${start}-${end}` }, extraHeaders || {}),
    redirect: 'follow',
    signal: ctrl.signal,
    // @ts-ignore Cloudflare 特有：cf 缓存按 url+Range 的形态不可靠，一律绕开
    cf: { cacheEverything: false },
  }).finally(() => clearTimeout(timer));
}

/**
 * 取一块，带**有限重试**（3 发，间隔 200/500ms）。
 *
 * 为什么必须有：CF 边缘 IP 是共享的，对夸克同一 CDN 同时开 16 条连接时，实测**第 4
 * 条起会被拒/掐**（住宅 IP 16 条全过，同一时刻本机复现 → 不是夸克封并发，是共享
 * 出口 IP 上的连接配额）。失败是一过性的 —— 立刻重发通常就好；一遇错就把整流
 * error 掉（旧做法）= 3 块即死。
 *
 * @param onAttempt 每发一次真实子请求前回调（用于全局子请求预算计数，重试也要算）
 * @returns {Promise<{res?: Response, status?: number, error?: string}>}
 */
async function fetchChunkRetry(url, headers, start, end, onAttempt) {
  let last = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt === 1 ? 200 : 500));
    if (onAttempt) onAttempt();
    try {
      const res = await fetchChunk(url, headers, start, end);
      if (res.ok) return { res, status: res.status };
      last = `HTTP ${res.status}`;
      if (res.body) { try { await res.body.cancel(); } catch { /* 无所谓 */ } }
      // 429 / 5xx 值得重试；其余 4xx 再试一发确认，仍不行就如实带状态给调用方
      if (!/^(429|5\d\d)$/.test(String(res.status)) && attempt >= 1) return { res, status: res.status };
    } catch (e) {
      last = String((e && e.message) || e);
    }
  }
  return { error: last };
}

/** 透传分支：客户端的 Range 原样给上游，响应流式回 */
async function pipeThrough(url, headers, reqMethod, reqRange) {
  const method = reqMethod === 'HEAD' ? 'HEAD' : 'GET';
  const want = Object.assign({}, headers);
  if (reqRange) want.Range = reqRange;
  const up = await fetch(url, { method, headers: want, redirect: 'follow' });
  const out = new Headers();
  out.set('cache-control', 'no-store');
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = up.headers.get(k);
    if (v) out.set(k, v);
  }
  if (method === 'HEAD' || !up.body) return new Response(null, { status: up.status, headers: out });
  return new Response(up.body, { status: up.status, headers: out });
}

/** 分块并发分支：探总长 → 有界切块 → threads 路在飞、按序吐（面板 relayChunked 的移植） */
async function chunked(url, headers, reqRange, threads, chunkSize) {
  /* 子请求实际计数（探针 + 每个块的每次重试都算）—— CF 免费版单请求 50 发，超了
     直接 1101；不能只按"块数"做预算，重试一多发就超 */
  let used = 0;
  const tick = () => { used += 1; };

  /* 探一发有界 Range 拿总长；探不出 / 上游不认 Range（回 200）就退回透传 */
  const probeR = await fetchChunkRetry(url, headers, 0, PROBE_BYTES - 1, tick);
  if (probeR.error || !probeR.res || probeR.status !== 206) {
    if (probeR.res && probeR.res.body) {
      try { await probeR.res.body.cancel(); } catch { /* 断不干净也无所谓 */ }
    }
    return pipeThrough(url, headers, 'GET', reqRange);
  }
  const probe = probeR.res;
  const cr = /\/(\d+)$/.exec(probe.headers.get('content-range') || '');
  if (probe.body) {
    try { await probe.body.cancel(); } catch { /* 同上 */ }
  }
  const total = cr ? Number(cr[1]) : 0;
  if (!total) return pipeThrough(url, headers, 'GET', reqRange);

  const r = resolveRange(parseRange(reqRange), total);
  const count = Math.max(1, Math.ceil((r.end - r.start + 1) / chunkSize));

  const out = new Headers();
  out.set('cache-control', 'no-store');
  out.set('accept-ranges', 'bytes');
  out.set('content-type', probe.headers.get('content-type') || 'application/octet-stream');
  out.set('content-length', String(r.end - r.start + 1));
  if (r.ranged) out.set('content-range', `bytes ${r.start}-${r.end}/${total}`);

  let launched = 0;
  const pending = new Map();
  const launch = () => {
    /* 两条硬上限：块数（本次要搬的）与子请求总数（含重试，给在飞的块留重试余量：
       每块最多 3 发，故只在 used ≤ MAX-3 时发新块）*/
    while (launched < count && pending.size < threads && used <= MAX_SUBREQUESTS - 3) {
      const i = launched;
      launched += 1;
      const a = r.start + i * chunkSize;
      pending.set(i, fetchChunkRetry(url, headers, a, Math.min(a + chunkSize - 1, r.end), tick));
    }
  };

  const body = new ReadableStream({
    async pull(ctrl) {
      if (!pending.size && (launched >= count || used > MAX_SUBREQUESTS - 3)) {
        ctrl.close(); // 搬完 / 子请求预算用尽：正常收尾，播放器拿断点重连续传
        return;
      }
      launch();
      const i = pending.keys().next().value;
      const got = await pending.get(i);
      pending.delete(i);
      if (got.error || !got.res) {
        /* 重试 3 发仍失败：把原因写进流尾再正常关闭，不静默 error —— 客户端至少拿到
           已下载部分，诊断在尾巴上看得见（旧做法直接 error = 3 块整流失效） */
        ctrl.enqueue(new TextEncoder().encode(`\n[media-bridge-relay] 第${i + 1}块取失败（重试 3 发）：${got.error || '未知'}`));
        ctrl.close();
        return;
      }
      const res = got.res;
      /* 上游不理会切块范围（回整片 200 等）：整流吐回，后续块作废 */
      if (res.status !== 206) {
        if (res.body) {
          await res.body.pipeTo(new WritableStream({ write: (c) => ctrl.enqueue(c) }));
        }
        pending.clear();
        launched = count;
        ctrl.close();
        return;
      }
      ctrl.enqueue(new Uint8Array(await res.arrayBuffer()));
    },
  });
  return new Response(body, { status: r.ranged ? 206 : 200, headers: out });
}

export default {
  async fetch(req, env) {
    const q = new URL(req.url).searchParams;
    const u = q.get('u') || '';
    const h = q.get('h') || '';
    const s = q.get('s') || '';
    if (!u) return new Response('缺 u（上游地址）', { status: 400 });

    /* 验签（配了 SECRET 才验）：防别人扫到 Worker 地址白嫖带宽 */
    const secret = (env && env.SECRET) || '';
    if (secret) {
      if (!s) return new Response('缺 s（签名）', { status: 403 });
      if ((await hmacB64Url(secret, u + (h ? '.' + h : ''))) !== s) {
        return new Response('签名不对', { status: 403 });
      }
    }

    let url;
    try {
      url = fromB64Url(u);
    } catch {
      return new Response('u 解不开', { status: 400 });
    }
    if (!/^https?:\/\//i.test(url)) return new Response('u 不是 http(s) 地址', { status: 400 });

    let headers = {};
    if (h) {
      try {
        headers = JSON.parse(fromB64Url(h)) || {};
      } catch {
        return new Response('h 解不开', { status: 400 });
      }
    }

    /* threads / chunkKB 都是面板「播放中继设置」传过来的；不带 → 单连接透传 */
    const threads = Math.max(1, Math.min(Number(q.get('threads')) || 0, 16));
    const chunkKB = Math.max(64, Math.min(Number(q.get('chunkKB')) || 0, 8192));
    const reqRange = req.headers.get('range') || '';
    if (!threads || !chunkKB || req.method !== 'GET') {
      return pipeThrough(url, headers, req.method, reqRange);
    }
    return chunked(url, headers, reqRange, threads, chunkKB * 1024);
  },
};
