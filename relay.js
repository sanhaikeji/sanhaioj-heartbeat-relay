/**
 * 心跳式中转 —— 三方链路的核心
 * ============================================
 *
 * 场景（2026-11-07）：学校禁止内网穿透（frp / cloudflared 隧道），
 * 但 OJ 源站在学校内网、外网访问不到（Cloudflare 返 530 / error 1033 = 隧道未连接）。
 * 同时「服务端要能找到外网的客户端」（推消息）。
 *
 * 链路：
 *   客户端 ──①长轮询──▶ 云服务 ──②长轮询──▶ agent ──③本地HTTP──▶ Hydro
 *        ◀───响应──────   ◀───────────────  ◀──────────────────
 *
 * 关键设计（安全性）：
 *   · 用户令牌由客户端交给云 → 云转给 agent → agent 原样带到插件的
 *     `/client-api/relay/forward` → **插件内部验令牌**并代发（不信 agent 自报 uid）。
 *     ⚠️ 令牌在链路上对云和 agent 是**可见**的 —— 这不可避免：
 *     插件只能靠令牌本身确定「你是谁」。所以 agent 必须是**自家内网、可信任**的进程，
 *     云侧日志也不许打令牌原文。
 *   · agent 用独立的 `X-Channel-Key`（通道密钥）向云认证，**常量时间比较**。
 *   · 插件侧**双验**（通道密钥 + 用户令牌），通道密钥只授「代发」权限。
 *
 * 零依赖：只用 Node 内置模块（http / crypto / fs / path）。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const STATE_DIR = path.join(ROOT, 'relay-state');

/** agent 通道密钥的来源（写文件，避免密钥进环境变量被 ps 看到）。环境变量 RELAY_AGENT_KEY 优先。 */
const AGENT_KEY_FILE = path.join(ROOT, 'relay-agent.key');

/** 长轮询挂住多久（毫秒）。到点没消息就返回空，让客户端/agent 重新发起。 */
const POLL_HOLD_MS = 25000;
/** 离线消息保留天数。 */
const MSG_TTL_DAYS = Number(process.env.RELAY_MSG_TTL_DAYS || 7);
/** 单个 uid 的待取队列上限（防止无限堆积）。 */
const MAX_QUEUE_PER_UID = 500;
/** 一次补拉最多返回多少条。 */
const MAX_BACKFILL = 100;

// ---------------------------------------------------------------- 常量时间比较

/**
 * 常量时间比较两个字符串。
 * <para>⛔ 不能用 `===` 或 `timingSafeEqual`（后者长度不等会抛）。
 * 通道密钥的比较必须**不泄露前缀长度**，所以先哈希再比（哈希结果定长）。
 */
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a || '')).digest();
    const hb = crypto.createHash('sha256').update(String(b || '')).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/** 取通道密钥：环境变量优先，其次同目录的 key 文件。
 *  ⚠️ 环境变量要**调用时**读 —— 模块加载时捕获的话，后设的 env 不生效
 *  （测试和某些部署方式都是先 require 后配置）。 */
function getAgentKey() {
    const env = String(process.env.RELAY_AGENT_KEY || '').trim();
    if (env) return env;
    try {
        const s = fs.readFileSync(AGENT_KEY_FILE, 'utf8').trim();
        if (s) return s;
    } catch { /* 没有这个文件 */ }
    return '';
}

// ---------------------------------------------------------------- 落盘状态

/**
 * 持久化状态：uid 映射（令牌 → uid）。
 * <para>为什么要存：**令牌 → uid 的映射需要问 OJ**（OJ 才是令牌权威），
 * 而云服务现在连不到 OJ（隧道 1033）→ 只能让 agent 代问。
 * agent 代问的结果回传后，这里就缓存下来了，之后不必再问。</para>
 */
const UID_MAP_FILE = path.join(STATE_DIR, 'uid-map.json');

/** 令牌指纹 → uid。指纹 = sha256(令牌) 前 16 位十六进制（不存令牌原文）。 */
let uidMap = {};
/** uid → 最近的序号（用于补拉）。 */
let seqByUid = {};

function loadState() {
    try {
        const raw = JSON.parse(fs.readFileSync(UID_MAP_FILE, 'utf8'));
        uidMap = raw.uidMap || {};
        seqByUid = raw.seqByUid || {};
    } catch { /* 第一次跑，文件还没有 */ }
}

let saveTimer = null;
function saveStateSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            fs.mkdirSync(STATE_DIR, { recursive: true });
            fs.writeFileSync(UID_MAP_FILE, JSON.stringify({ uidMap, seqByUid }), 'utf8');
        } catch (e) {
            console.log('[relay] 状态写盘失败：' + e.message);
        }
    }, 2000);
}
if (saveTimer && saveTimer.unref) saveTimer.unref();

// ---------------------------------------------------------------- 队列

/**
 * 待取队列：uid → [msg]。
 * <para>消息 = { seq, type, data, at }。seq 全局单调递增（按 uid 记 lastSeq）。</para>
 */
const queues = new Map();

/** 全局序号。 */
let globalSeq = 0;

/** 排队一条消息给某个 uid。返回分配的序号。 */
function enqueue(uid, type, data) {
    const u = String(uid);
    let q = queues.get(u);
    if (!q) { q = []; queues.set(u, q); }
    globalSeq += 1;
    const msg = { seq: globalSeq, type, data, at: Date.now() };
    q.push(msg);
    if (q.length > MAX_QUEUE_PER_UID) q.splice(0, q.length - MAX_QUEUE_PER_UID);
    const last = Number(seqByUid[u] || 0);
    if (msg.seq > last) seqByUid[u] = msg.seq;
    saveStateSoon();
    return msg.seq;
}

/** 取某个 uid 队列里的全部消息（取完清空 —— 短轮询语义：谁取谁负责）。 */
function drainQueue(uid) {
    const u = String(uid);
    const q = queues.get(u);
    if (!q || !q.length) return [];
    queues.delete(u);
    return q;
}

/** 队列里现在有多少条（健康检查用）。 */
function queueStats() {
    let n = 0;
    for (const q of queues.values()) n += q.length;
    return { uids: queues.size, messages: n };
}

// ---------------------------------------------------------------- 待处理请求

/**
 * 「客户端发起、要打到 OJ」的请求队列。
 * <para>按 requestId 索引；客户端拿结果时按 id 认领。</para>
 * <p>⚠️⚠️ **请求里带着用户令牌** —— 这是**不可避免**的：
 * 插件的转发接口要确定「这是哪个用户」，只能靠用户令牌本身
 * （插件不信任 agent 自报的 uid）。
 * 所以 agent 在链路上**会短暂看到用户令牌**。
 * <p>因此安全模型是：<b>信任 agent</b>（它是你自己部署在内网的进程），
 * 而**通道密钥**只授予「代发」权限、不能直接调业务接口。
 * 真正的防线在插件侧 —— 它验通道密钥 + 验用户令牌，两者缺一不可。</p>
 */
const pending = new Map();   // requestId → { uid, userToken, method, path, query, at }
const results = new Map();   // requestId → { status, body }

/** 放一个待转发请求。userToken = 客户端的令牌（链路里带到插件验身份）。 */
function pushRequest(uid, req, userToken) {
    const id = String(req.id || '');
    if (!id) return null;
    pending.set(id, {
        uid: String(uid),
        userToken: String(userToken || ''),
        method: String(req.method || 'GET').toUpperCase(),
        path: String(req.path || ''),
        query: req.query || {},
        at: Date.now(),
    });
    return id;
}

/** agent 取走待转发请求（按到达顺序）。 */
function takeRequests(limit) {
    const out = [];
    for (const [id, r] of pending) {
        if (out.length >= limit) break;
        out.push({ id, ...r });
        pending.delete(id);
    }
    return out;
}

/** agent 回报结果。 */
function putResult(id, status, body) {
    const key = String(id || '');
    if (!key) return false;
    results.set(key, { status: Number(status) || 0, body });
    return true;
}

/** 客户端按 id 认领结果（领走即删）。 */
function takeResults(ids) {
    const out = [];
    for (const id of ids || []) {
        const key = String(id);
        if (results.has(key)) {
            out.push({ id: key, ...results.get(key) });
            results.delete(key);
        }
    }
    return out;
}

// ---------------------------------------------------------------- uid 映射

/** 记住「这个令牌是那个 uid」。只存指纹，不存令牌。 */
function rememberUid(token, uid) {
    if (!token || !uid) return;
    uidMap[tokenFingerprint(token)] = { uid: Number(uid), at: Date.now() };
    saveStateSoon();
}

/** 查 uid（命中缓存就返回 null 让调用方去问）。 */
function lookupUid(token) {
    if (!token) return null;
    const hit = uidMap[tokenFingerprint(token)];
    if (!hit) return null;
    return hit.uid;
}

/** 令牌指纹（不存原文）。 */
function tokenFingerprint(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- agent 状态

/** agent 最后一次心跳的时间（毫秒）。0 = 从未连过。 */
let agentLastSeen = 0;
/** agent 在线与否的宽限期（心跳断了多久算离线）。 */
const AGENT_OFFLINE_AFTER_MS = 70000;

function agentOnline() {
    return agentLastSeen > 0 && (Date.now() - agentLastSeen) < AGENT_OFFLINE_AFTER_MS;
}

// ---------------------------------------------------------------- 路由

/** 路径白名单：只放行 /client-api/<段>（每段只允许字母数字下划线连字符）。
 *  ⚠️ 不能放 '.' 或 '/' 自由组合 —— `/client-api/../../etc/passwd` 要挡在门外。 */
function pathOk(p) {
    return /^\/client-api\/[A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_\-]+)*$/.test(p);
}

/**
 * 客户端长轮询的核心逻辑（纯函数式，返回 {code, obj}）。
 * <para>顺序刻意是「先确认身份、再收请求」：身份都还没确认（或令牌无效）时，
 * 一条请求都不该进队 —— 否则无效令牌的请求会被 agent 转发一遍，白占通道。</para>
 */
async function clientPollCore(body) {
    const token = String((body && body.token) || '').trim();
    if (!token) return { code: 401, obj: { ok: false, error: '缺少令牌' } };

    // uid 映射：优先用缓存；没有就让 agent 代问（云自己够不到 OJ）。
    let uid = lookupUid(token);
    if (!uid) {
        const got = await resolveUidByAgent(token);
        if (got === null) {
            // agent 不在线 / 超时 —— 不是「令牌无效」，让客户端稍后重试。
            return {
                code: 503,
                obj: { ok: false, error: '中转正在确认你的身份，稍后重试', retryAfterMs: 2000 },
            };
        }
        if (got === 0) {
            // agent 问过了，OJ 明确说这个令牌不行。
            return { code: 401, obj: { ok: false, error: '令牌无效、已过期或已被撤销' } };
        }
        uid = got;
    }

    // 上行请求：入队，等 agent 来取。⚠️ 带上令牌 —— 插件要靠它验身份。
    const reqs = Array.isArray(body && body.requests) ? body.requests : [];
    const accepted = [];
    for (const r of reqs) {
        const p = String(r && r.path || '');
        if (!pathOk(p)) continue;
        const id = pushRequest(uid, r, token);
        if (id) accepted.push(id);
    }

    // 拿结果（按客户端报的 id 认领）+ 拿消息（离线期间攒的）。
    const responses = takeResults(body && body.resultIds);
    const events = drainQueue(uid);

    // 如果这一轮没东西，别空转 —— 挂住等 agent 或新消息。
    const waitMs = (!responses.length && !events.length && agentOnline()) ? POLL_HOLD_MS : 0;
    if (waitMs > 0) {
        await waitForWork(uid, waitMs);
    }

    const finalResponses = takeResults(body && body.resultIds);
    const finalEvents = drainQueue(uid);
    finalResponses.push(...responses);
    finalEvents.push(...events);

    return {
        code: 200,
        obj: {
            ok: true,
            uid: Number(uid),
            seq: Number(seqByUid[String(uid)] || 0),
            accepted,
            responses: finalResponses,
            events: finalEvents,
        },
    };
}

/** 客户端长轮询：取结果 + 取消息；同时把上行请求塞进待转发队列。 */
async function handleClientPoll(req, res, body) {
    const { code, obj } = await clientPollCore(body);
    return sendJson(res, code, obj);
}

/**
 * 让 agent 代问「这个令牌是谁」。
 * <para>机制：造一条特殊请求（带用户令牌的 whoami）丢进 agent 队列，
 * agent 取到后问插件，回报时带回 uid。</para>
 * <para>返回值约定：<b>数字</b>=uid（问到了）；<b>0</b>=OJ 明确拒绝（令牌无效）；
 * <b>null</b>=问不出来（agent 离线/超时，不代表令牌坏）。</para>
 */
let uidQuerySeq = 0;
const uidQueries = new Map();   // queryId → { token, resolve, at }

async function resolveUidByAgent(token) {
    if (!agentOnline()) return null;
    uidQuerySeq += 1;
    const qid = 'uq' + uidQuerySeq;
    let resolveFn;
    const p = new Promise((r) => { resolveFn = r; });
    uidQueries.set(qid, { token, resolve: resolveFn, at: Date.now() });
    // 塞进 agent 的待取队列（走 pending，agent 会当成一条请求取走）。
    // ⚠️ 必须带上 userToken —— 插件验的是令牌本身，whoami 没令牌就是 401。
    pushRequest('?', {
        id: qid, method: 'GET', path: '/client-api/auth/whoami', query: { __uidQuery: '1' },
    }, token);
    const t = setTimeout(() => {
        if (uidQueries.has(qid)) { uidQueries.delete(qid); resolveFn(null); }
    }, 12000);
    if (t && t.unref) t.unref();
    const got = await p;
    return got;
}

/**
 * agent 回报 uid 查询结果时调这个。
 * <para>uid &gt; 0 = 问到了；0 = 明确拒绝；null = 没问出来（超时/网络错）。</para>
 */
function settleUidQuery(qid, uid) {
    const q = uidQueries.get(qid);
    if (!q) return false;
    uidQueries.delete(qid);
    if (uid > 0) {
        rememberUid(q.token, uid);
        q.resolve(Number(uid));
    } else {
        q.resolve(uid === 0 ? 0 : null);
    }
    return true;
}

/**
 * 等活儿：挂住最多 ms，期间有新东西就醒。
 * <para>用 setTimeout 轮询（30ms 一跳）—— 零依赖实现简单，几十个并发完全够用。</para>
 */
async function waitForWork(uid, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30));
        if (queues.has(String(uid)) && queues.get(String(uid)).length) return;
        if (results.size) return;
    }
}

/** agent 长轮询：取待转发请求 + 回报结果。 */
async function handleAgentPoll(req, res, body) {
    const key = String(req.headers['x-channel-key'] || '');
    const expect = getAgentKey();
    if (!expect) {
        return sendJson(res, 503, { ok: false, error: 'agent 通道未启用（服务端没配 RELAY_AGENT_KEY）' });
    }
    if (!safeEqual(key, expect)) {
        return sendJson(res, 401, { ok: false, error: '通道密钥不对' });
    }
    agentLastSeen = Date.now();

    // agent 回报的结果
    const reported = Array.isArray(body && body.results) ? body.results : [];
    for (const r of reported) {
        const id = String(r && r.id || '');
        // uid 查询的回答：特殊处理
        if (id.startsWith('uq')) {
            const uid = Number((r.body && r.body.uid) || 0);
            if (uid > 0) {
                settleUidQuery(id, uid);
            } else if (Number(r.status) === 401 || Number(r.status) === 403) {
                // 插件明确拒绝 = 这个令牌就是不行（区别于网络错误）
                settleUidQuery(id, 0);
            } else {
                settleUidQuery(id, -1);   // 问不出来，让客户端重试
            }
            continue;
        }
        putResult(id, r.status, r.body);
    }

    // 取待转发请求
    const requests = takeRequests(Number(body && body.limit) || 20);

    // 没有活儿就挂住等
    if (!requests.length) {
        await waitForAgent(12000);
        requests.push(...takeRequests(20));
    }

    return sendJson(res, 200, { ok: true, requests });
}

/** 等 agent 有活儿（12 秒）。 */
async function waitForAgent(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30));
        if (pending.size) return;
    }
}

/** 健康检查。 */
function handleHealth(res) {
    return sendJson(res, 200, {
        ok: true,
        service: 'sanhaioj-relay',
        agentOnline: agentOnline(),
        agentLastSeen: agentLastSeen || null,
        agentKeyConfigured: !!getAgentKey(),
        queue: queueStats(),
        pending: pending.size,
        results: results.size,
        uidMapSize: Object.keys(uidMap).length,
        note: '隧道 1033 时云直连不到 OJ，uid 映射靠 agent 代问',
    });
}

function sendJson(res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

loadState();

module.exports = {
    handleClientPoll,
    handleAgentPoll,
    handleHealth,
    enqueue,
    safeEqual,
    getAgentKey,
    rememberUid,
    lookupUid,
    agentOnline,
    queueStats,

    // ---- 下面这些只为测试（relay-test.mjs）导出，线上不用 ----
    // ⚠️ 它们让测试能直接驱动内部逻辑，而不用起一个真的 HTTP 服务。
    takeRequestsForTest: takeRequests,
    putResultForTest: putResult,
    takeResultsForTest: takeResults,
    waitForAgentForTest: waitForAgent,
    settleUidQueryForTest: settleUidQuery,
    // 客户端长轮询的测试入口：**直接走真实核心逻辑**（clientPollCore），
    // 只是不写 HTTP。⚠️ 别在这里复制一份逻辑 —— 两份必然漂移，测的就不是线上那份了。
    handleClientPollForTest: async (body) => {
        const { obj } = await clientPollCore(body);
        return obj;
    },
};
