/**
 * 心跳中转 · 云侧独立入口
 * ========================
 *
 * 把 relay.js 的三个处理器挂在一个最小 HTTP 服务上，**零依赖**（只用 Node 内置模块）。
 * 这样中转站可以单独部署，不必绑死任何全家桶后端。
 *
 * 路由：
 *   POST /relay/poll        客户端长轮询（提交上行请求 + 取结果/消息）
 *   POST /relay/agent/poll  内网 agent 长轮询（取请求 + 回报结果）
 *   GET  /relay/health      中转健康检查（agent 在线状态、队列深度）
 *   GET  /health            服务存活探针
 *
 * 配置（环境变量）：
 *   PORT               监听端口（默认 8787）
 *   RELAY_AGENT_KEY    agent 通道密钥（必配，为空 = agent 通道关闭）
 *   RELAY_MSG_TTL_DAYS 离线消息保留天数（默认 7）
 *
 * 运行：node server.js
 */
'use strict';

const http = require('http');
const relay = require('./relay');

const PORT = Number(process.env.PORT || 8787);

const server = http.createServer((req, res) => {
    // ⚠️ 必须解析 pathname，不能裸比 req.url：客户端走系统代理时请求行会是
    //    **绝对 URI**（http://host/relay/poll），裸比较会全部落到 404。
    //    （.NET HttpClient 在 Windows 上就会这样，curl 反而不复现。）
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { pathname = req.url || ''; }
    let body = '';
    req.on('data', (c) => {
        body += c;
        // 请求体上限 2MB —— 中转的是接口调用，不是文件上传
        if (body.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* 空体或坏 JSON 当空处理 */ }

        try {
            if (req.method === 'POST' && pathname === '/relay/poll') {
                return await relay.handleClientPoll(req, res, parsed);
            }
            if (req.method === 'POST' && pathname === '/relay/agent/poll') {
                return await relay.handleAgentPoll(req, res, parsed);
            }
            if (req.method === 'GET' && pathname === '/relay/health') {
                return relay.handleHealth(res);
            }
            if (req.method === 'GET' && pathname === '/health') {
                const b = Buffer.from(JSON.stringify({ ok: true, service: 'heartbeat-relay' }), 'utf8');
                res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': b.length });
                return res.end(b);
            }
        } catch (e) {
            console.log('[server] 处理出错：' + (e && e.message));
            const b = Buffer.from(JSON.stringify({ ok: false, error: 'internal error' }), 'utf8');
            res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': b.length });
            return res.end(b);
        }

        const b = Buffer.from(JSON.stringify({ ok: false, error: '没有这个路由' }), 'utf8');
        res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': b.length });
        res.end(b);
    });
});

server.listen(PORT, () => {
    console.log(`[relay] 心跳中转已启动：http://127.0.0.1:${PORT}`);
    console.log(`[relay] agent 通道密钥：${relay.getAgentKey() ? '已配置' : '⚠️ 未配置（设 RELAY_AGENT_KEY 或放 relay-agent.key 文件）'}`);
    console.log('[relay] 路由：POST /relay/poll、POST /relay/agent/poll、GET /relay/health、GET /health');
});
