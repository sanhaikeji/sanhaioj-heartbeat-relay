#!/usr/bin/env node
/**
 * 心跳 agent —— 内网侧常驻进程
 * ============================================
 *
 * 作用：在**学校内网**跑一个常驻进程，主动外连 WorkBuddy 云服务，
 * 把云服务转来的请求用本地 HTTP 打到 Hydro，再把结果报回去。
 *
 * 为什么需要它（2026-11-07）：
 *   学校禁止内网穿透（frp / cloudflared），OJ 在内网、外网访问不到
 *   （Cloudflare 返 530 / error 1033 = 隧道未连接）。
 *   云服务在公网，**也够不到内网的 OJ** —— 除非有人从内网主动出去。
 *   agent 就是那个「从内网主动出去」的人。
 *
 * 合规性：agent **不对外监听任何端口**，只发起出向 HTTP 请求。
 *   从网络策略看，它和「浏览器访问网站」没区别。
 *
 * 安全（重要）：
 *   · agent **不持有用户令牌**。用户令牌由云转来，但 agent 转发时
 *     **原样带上**，由**插件内部**验 —— agent 自己从不解析、不记录令牌。
 *   · agent 用独立的通道密钥（X-Channel-Key）向云认证。
 *   · agent 只信任**固定的一台云**（由参数指定），不连任何别的地方。
 *
 * 用法：
 *   node agent.js --relay https://sanhaioj-client-beta.app.workbuddy.host \
 *                   --key ./relay-agent.key \
 *                   --oj http://127.0.0.1:8888
 *
 * 零依赖：只用 Node 内置模块。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ---------------------------------------------------------------- 参数

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
    return def;
}

const RELAY = String(arg('relay', process.env.RELAY_URL || 'https://sanhaioj-client-beta.app.workbuddy.host')).replace(/\/+$/, '');
const KEY_FILE = arg('key', process.env.RELAY_AGENT_KEY_FILE || path.join(__dirname, 'relay-agent.key'));
/** OJ 的本地地址。默认 hydrooj 常见的 8888。 */
const OJ = String(arg('oj', process.env.OJ_LOCAL || 'http://127.0.0.1:8888')).replace(/\/+$/, '');
/** 长轮询挂住多久（毫秒）。要比云的持有时间略短，避免两边错位。 */
const POLL_MS = Number(arg('poll', '20000'));
/** 断线重连的退避上限。 */
const BACKOFF_MAX_MS = 30000;

let CHANNEL_KEY = '';
try {
    CHANNEL_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
} catch (e) {
    console.error('[agent] 读不到通道密钥文件：' + KEY_FILE + '（' + e.message + '）');
    console.error('[agent] 密钥内容应该是一串随机字符，由管理员在中转站侧配好后下发。');
    process.exit(1);
}
if (!CHANNEL_KEY) {
    console.error('[agent] 通道密钥是空的，中止。');
    process.exit(1);
}

console.log(`[agent] 云=${RELAY}`);
console.log(`[agent] OJ=${OJ}`);
console.log(`[agent] 密钥=${KEY_FILE}（${CHANNEL_KEY.length} 字符）`);

// ---------------------------------------------------------------- HTTP 帮手

/** 发一个 JSON 请求，返回 { status, body }。 */
function postJson(urlStr, obj, headers, timeoutMs) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(urlStr); } catch (e) {
            resolve({ status: 0, body: { ok: false, error: 'URL 不合法：' + e.message } });
            return;
        }
        const mod = u.protocol === 'http:' ? http : https;
        const body = Buffer.from(JSON.stringify(obj), 'utf8');
        let done = false;
        const finish = (r) => { if (!done) { done = true; resolve(r); } };

        const req = mod.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'http:' ? 80 : 443),
            path: u.pathname + (u.search || ''),
            method: 'POST',
            headers: Object.assign({
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': body.length,
                'Accept': 'application/json',
            }, headers || {}),
            timeout: timeoutMs || (POLL_MS + 15000),
        }, (r) => {
            let text = '';
            r.setEncoding('utf8');
            r.on('data', (c) => {
                text += c;
                if (text.length > 4 * 1024 * 1024) { req.destroy(); }
            });
            r.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(text); } catch { parsed = { ok: false, error: '不是 JSON', raw: text.slice(0, 300) }; }
                finish({ status: r.statusCode, body: parsed });
            });
        });
        req.on('timeout', () => { req.destroy(); finish({ status: 0, body: { ok: false, error: '超时' } }); });
        req.on('error', (e) => finish({ status: 0, body: { ok: false, error: e && e.message ? e.message : String(e) } }));
        req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------- 打 OJ

/**
 * 把云转来的请求打到本地 OJ 的**转发路由**（插件的 /client-api/relay/forward）。
 *
 * <para>⚠️ 不直打业务路径！转发路由做**双验**：通道密钥（X-Channel-Key，证明是自家
 * agent）+ 用户令牌（body 里的 userToken，确定「你是谁」）—— 两者缺一不可。
 * 业务 handler 由插件内部代发，agent 不碰鉴权。</para>
 *
 * <para>⚠️ **用户令牌原样带过，不解析、不落盘、不打日志。**</para>
 *
 * <para>返回值：把转发路由的信封 <c>{ok, status, body}</c> **拆开**，
 * 只把内层 <c>{status, body}</c> 报回云 —— 客户端看到的就是业务接口的原样响应。</para>
 */
function callOj(r) {
    return new Promise((resolve) => {
        const urlStr = OJ + '/client-api/relay/forward';
        let u;
        try { u = new URL(urlStr); } catch (e) {
            resolve({ status: 0, body: { ok: false, error: 'URL 不合法：' + e.message } });
            return;
        }

        const method = String(r.method || 'GET').toUpperCase();
        const payload = Buffer.from(JSON.stringify({
            userToken: String(r.userToken || ''),
            path: String(r.path || ''),
            method,
            query: r.query || {},
            body: r.body || {},
        }), 'utf8');

        const headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': payload.length,
            'X-Channel-Key': CHANNEL_KEY,
            // ⚠️ 站点有防盗刷：UA 必须含 OjClient。agent 直连 Hydro 时若前面还挂着
            //    Caddy 那层，缺这个头会被拦在插件之前（表现为「转发全部 403」）。
            'User-Agent': 'OjClient/1.0 (heartbeat-relay)',
        };

        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };

        const req = http.request({
            hostname: u.hostname,
            port: u.port || 80,
            path: u.pathname + (u.search || ''),
            method: 'POST',
            headers,
            timeout: 30000,
        }, (resp) => {
            let text = '';
            resp.setEncoding('utf8');
            resp.on('data', (c) => {
                text += c;
                if (text.length > 8 * 1024 * 1024) req.destroy();
            });
            resp.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(text); } catch { parsed = { ok: false, error: '不是 JSON', raw: text.slice(0, 500) }; }
                // 拆信封：{ok:true, status, body} → 报内层；其它（fail 信封）原样报。
                if (parsed && parsed.ok === true && parsed.status !== undefined) {
                    finish({ status: Number(parsed.status), body: parsed.body });
                } else {
                    finish({ status: resp.statusCode, body: parsed });
                }
            });
        });
        req.on('timeout', () => { req.destroy(); finish({ status: 0, body: { ok: false, error: '打 OJ 超时' } }); });
        req.on('error', (e) => finish({ status: 0, body: { ok: false, error: e && e.message ? e.message : String(e) } }));
        req.write(payload);
        req.end();
    });
}

// ---------------------------------------------------------------- 主循环

let backoff = 1000;
let running = false;

/** 一轮心跳。 */
async function tick(results) {
    const r = await postJson(RELAY + '/relay/agent/poll', {
        results: results || [],
        limit: 20,
    }, { 'X-Channel-Key': CHANNEL_KEY }, POLL_MS + 15000);

    if (r.status !== 200 || !r.body || r.body.ok !== true) {
        const err = (r.body && r.body.error) || ('HTTP ' + r.status);
        throw new Error('云服务拒绝：' + err);
    }

    const reqs = Array.isArray(r.body.requests) ? r.body.requests : [];
    if (!reqs.length) return [];

    // 逐个转发到 OJ
    const out = [];
    for (const q of reqs) {
        try {
            const res = await callOj(q);
            out.push({ id: q.id, status: res.status, body: res.body });
            // ⚠️ 别把 userToken 打进日志
            console.log(`[agent] 转发 ${q.method || 'GET'} ${q.path} → ${res.status}`);
        } catch (e) {
            out.push({ id: q.id, status: 0, body: { ok: false, error: e.message } });
        }
    }
    return out;
}

async function loop() {
    if (running) return;
    running = true;
    let carry = [];
    while (true) {
        try {
            const out = await tick(carry);
            carry = out;
            backoff = 1000;                        // 通了就重置退避
            console.log('[agent] 心跳正常');
        } catch (e) {
            console.log(`[agent] 心跳失败（${e.message}），${backoff}ms 后重试`);
            // ⚠️ 失败时**要把已拿到的结果带上重发**（否则结果丢了客户端就永远等不到）
            await new Promise((r) => setTimeout(r, backoff));
            backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
            continue;
        }
    }
}

process.on('SIGINT', () => { console.log('[agent] 收到 SIGINT，退出'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[agent] 收到 SIGTERM，退出'); process.exit(0); });

loop().catch((e) => { console.error('[agent] 崩了：', e); process.exit(1); });
