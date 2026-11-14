/**
 * 心跳中转的端到端自测（三方：客户端 → 云 → agent → OJ）。
 *
 * <p>跑法：node relay-test.cjs</p>
 * <p>它会：起一个假的 OJ（模拟插件的 /client-api/relay/forward 转发路由），
 * 起一个真的云服务（直接调 relay.js 的 handleClientPoll / handleAgentPoll ——
 * 测的就是线上那份逻辑），起一个真的 agent（relay-agent/agent.js），
 * 然后让「客户端」走完整链路。</p>
 */
'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const RELAY = require(path.join(ROOT, 'relay.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}

// ---------------------------------------------------------------- 假的 OJ

/** 假的 OJ：模拟插件的转发路由（/client-api/relay/forward，双验：通道密钥 + 用户令牌）。 */
const OJ_TOKENS = new Map();     // token → uid

function startFakeOj(channelKey) {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                let parsed = {};
                try { parsed = JSON.parse(body || '{}'); } catch { /* 空 */ }
                const send = (code, obj) => {
                    const b = Buffer.from(JSON.stringify(obj), 'utf8');
                    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
                    res.end(b);
                };
                // 跟插件 RelayForwardHandler 同一口径：只认转发路由
                if (req.url !== '/client-api/relay/forward') {
                    return send(404, { ok: false, error: `没有这个接口：${req.url}` });
                }
                const key = String(req.headers['x-channel-key'] || '');
                if (key !== channelKey) {
                    return send(401, { ok: false, error: '通道密钥不对' });
                }
                const tok = String(parsed.userToken || '');
                const uid = OJ_TOKENS.get(tok);
                if (!uid) {
                    // 插件行为：fail('用户令牌无效…', 401)
                    return send(401, { ok: false, error: '用户令牌无效、已过期或已被撤销' });
                }
                // 插件行为：okWithStatus(200, { status: 200, body: <内层> })
                return send(200, { ok: true, status: 200, body: { ok: true, uid } });
            });
        });
        srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
    });
}

// ---------------------------------------------------------------- 真的云服务

/**
 * 起一个真的云服务：**直接调 relay.js 的真实 handler**（handleClientPoll /
 * handleAgentPoll），只做 HTTP 收发的薄壳。这样 agentOnline、uid 代问、
 * 结果认领测的全都是线上代码，不存在「测试版逻辑」。
 */
function startFakeCloud() {
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
            let parsed = {};
            try { parsed = JSON.parse(body || '{}'); } catch { /* 空 */ }
            try {
                if (req.url === '/relay/agent/poll' && req.method === 'POST') {
                    return await RELAY.handleAgentPoll(req, res, parsed);
                }
                if (req.url === '/relay/poll' && req.method === 'POST') {
                    return await RELAY.handleClientPoll(req, res, parsed);
                }
            } catch (e) {
                const b = Buffer.from(JSON.stringify({ ok: false, error: e.message }), 'utf8');
                res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': b.length });
                return res.end(b);
            }
            const b = Buffer.from(JSON.stringify({ ok: false, error: '没有这个路由' }), 'utf8');
            res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': b.length });
            res.end(b);
        });
    });
    return new Promise((resolve) => {
        srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
    });
}

// ---------------------------------------------------------------- 开跑

(async function main() {
    console.log('\n=== 心跳中转：端到端测试 ===\n');

    const AGENT_KEY = 'e2e-channel-key-abcdef123456';
    process.env.RELAY_AGENT_KEY = AGENT_KEY;

    const oj = await startFakeOj(AGENT_KEY);
    const cloud = await startFakeCloud();
    console.log(`  假 OJ 端口 ${oj.port}，假云端口 ${cloud.port}`);

    // 造一个「合法用户」
    const USER_TOKEN = 'user-token-for-e2e-test-1234567890';
    OJ_TOKENS.set(USER_TOKEN, 42);

    // ⚠️ 密钥文件必须在 agent **启动前**写好 —— agent 一启动就读，读不到直接退出。
    const keyFile = path.join(require('os').tmpdir(), 'ojrelay-e2e-' + process.pid + '.key');
    require('fs').writeFileSync(keyFile, AGENT_KEY);
    const agent = spawn(process.execPath, [path.join(ROOT, 'relay-agent', 'agent.js'),
        '--relay', `http://127.0.0.1:${cloud.port}`,
        '--key', keyFile,
        '--oj', `http://127.0.0.1:${oj.port}`],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let agentOut = '';
    agent.stdout.on('data', (c) => { agentOut += c.toString(); });
    agent.stderr.on('data', (c) => { agentOut += c.toString(); });

    const cleanup = () => {
        try { agent.kill(); } catch { /* ignore */ }
        try { oj.srv.close(); } catch { /* ignore */ }
        try { cloud.srv.close(); } catch { /* ignore */ }
        try { require('fs').unlinkSync(keyFile); } catch { /* ignore */ }
    };
    process.on('exit', cleanup);

    // 等 agent 连上（它一起来就发第一次心跳）
    for (let i = 0; i < 20 && !RELAY.agentOnline(); i++) {
        await new Promise((r) => setTimeout(r, 200));
    }
    ok('agent 已连上云', RELAY.agentOnline(), agentOut.slice(-300));

    console.log('\n① 客户端首次连接（uid 由 agent 代问，之后请求入队）');
    {
        const t0 = Date.now();
        const r = await RELAY.handleClientPollForTest({
            token: USER_TOKEN,
            requests: [{ id: 'q1', method: 'GET', path: '/client-api/auth/whoami' }],
        });
        const ms = Date.now() - t0;
        ok('拿到 uid', r && r.uid === 42, JSON.stringify(r).slice(0, 200));
        ok(`耗时合理（${ms}ms）`, ms < 8000, `${ms}ms`);
        ok('请求已被受理', Array.isArray(r.accepted) && r.accepted.includes('q1'));
    }

    console.log('\n② 等 agent 转发并拿回结果');
    {
        let got = null;
        for (let i = 0; i < 20; i++) {
            const r = await RELAY.handleClientPollForTest({
                token: USER_TOKEN,
                resultIds: ['q1'],
            });
            if (r.responses && r.responses.length) { got = r.responses[0]; break; }
            await new Promise((res) => setTimeout(res, 400));
        }
        ok('拿回了 agent 的结果', !!got, JSON.stringify(got).slice(0, 200));
        ok('结果是成功（200）', got && got.status === 200, `status=${got && got.status}`);
        ok('结果里 uid 是 42', got && got.body && got.body.uid === 42,
            JSON.stringify(got && got.body).slice(0, 200));
    }

    console.log('\n③ 无效令牌 → 直接 401，且请求不入队');
    {
        const BAD = 'bad-token-should-be-rejected-123456';
        const t0 = Date.now();
        const r = await RELAY.handleClientPollForTest({
            token: BAD,
            requests: [{ id: 'q2', method: 'GET', path: '/client-api/auth/whoami' }],
        });
        const ms = Date.now() - t0;
        ok('无效令牌被拒（ok:false + 令牌字样）',
            r && r.ok === false && /令牌/.test(String(r.error || '')), JSON.stringify(r).slice(0, 200));
        ok('请求没有被受理（不入队）', !(r.accepted && r.accepted.includes('q2')),
            `accepted=${JSON.stringify(r.accepted)}`);
        ok(`明确拒绝也要走一遍代问（${ms}ms）`, ms < 8000, `${ms}ms`);
    }

    console.log('\n④ agent 用错通道密钥 → 拿不到请求');
    {
        const badKeyFile = path.join(require('os').tmpdir(), 'ojrelay-bad-' + process.pid + '.key');
        require('fs').writeFileSync(badKeyFile, 'wrong-key-000000000');
        const badAgent = spawn(process.execPath, [path.join(ROOT, 'relay-agent', 'agent.js'),
            '--relay', `http://127.0.0.1:${cloud.port}`,
            '--key', badKeyFile,
            '--oj', `http://127.0.0.1:${oj.port}`],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
        let badOut = '';
        badAgent.stdout.on('data', (c) => { badOut += c.toString(); });
        badAgent.stderr.on('data', (c) => { badOut += c.toString(); });
        await new Promise((r) => setTimeout(r, 1500));
        // 错密钥的 agent 应该被云明确拒绝
        ok('错密钥的 agent 被云拒绝', /云服务拒绝/.test(badOut), badOut.slice(-300));
        // 正常的请求照常入队（好 agent 在干活，链路没被坏 agent 影响）
        const r = await RELAY.handleClientPollForTest({
            token: USER_TOKEN,
            requests: [{ id: 'q3', method: 'GET', path: '/client-api/auth/whoami' }],
        });
        ok('链路正常（好 agent 的请求照常受理）', r.accepted && r.accepted.includes('q3'),
            JSON.stringify(r).slice(0, 200));
        try { badAgent.kill(); } catch { /* ignore */ }
        try { require('fs').unlinkSync(badKeyFile); } catch { /* ignore */ }
    }

    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
    console.log(agentOut.split('\n').slice(-8).join('\n'));
    cleanup();
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
