# 心跳式中转方案（替换内网穿透）

> **这份文档讲「为什么这么设计」和「最终定成什么样」。**
> 要动手部署请直接看 [根目录 README](../README.md) —— 那才是照抄手册。
>
> 原设计稿：2026-11-07；文档重写定稿：**2026-11-14**。
> 文档末尾有一节「历史推演修正记录」，列清楚早期哪些说法**已经被推翻**，
> 免得有人翻到旧版文档照着做。

---

## 一、前提：学校禁止内网穿透

OJ 源站（`www.myijk.com`，Hydro 内核）只在学校内网可达。学校**不允许内网穿透**
（frp / cloudflared 之类），Cloudflare 隧道是**被主动关闭**的。

> ⚠️⚠️ `www.myijk.com` 返回 **HTTP 530 / `error code: 1033`**，
> 是「隧道被主动关闭」的**常态**，不是进程挂了、不是配置错了。
> **不要重启 `cloudflared`，不要排查隧道，不要等它自己恢复。**
>
> 曾经从云服务自检接口拿到的证据：
> `{"ok":true,"reachable":true,"detail":"OJ 返回 HTTP 530","ojBody":"error code: 1033\n"}`
> —— 网络是通的，是隧道根本不存在。**这条链路要按「永远没有隧道」来设计。**

### 为什么心跳比内网穿透更合规

学校禁的是「**把内网服务暴露到公网**」，不是「出站」。

| | 传统内网穿透 | 心跳中转 |
|---|---|---|
| 发起方 | 内网机器**暴露端口**，等外面连进来 | 内网机器**主动连出去** |
| 对外开放的端口 | 有 | **没有** |
| 网络策略视角 | 一个公开隧道 = 内网入口 | 只有持续的出向 HTTP 连接 |
| 隧道被禁后 | 完全不可用 | 可用 |

心跳 agent 对外**不监听任何端口**，只维持出向 HTTP 长轮询 —— 从防火墙看，
它和「一台电脑在浏览网页」没区别。

---

## 二、链路（三段，全是出向）

```
  外网/学生家              公网                      学校内网
┌──────────┐   ① 长轮询   ┌──────────────┐  ② 长轮询  ┌──────────┐ ③ 本地 HTTP ┌──────────────┐
│  客户端   │ ──────────▶ │  云中转站     │ ◀───────── │ 心跳 agent│ ──────────▶ │ Hydro 插件   │
│          │ ◀────────── │ relay.js     │ ─────────▶ │ 常驻进程  │ ◀────────── │ relay/forward│
└──────────┘   响应/推送   └──────────────┘  请求/结果  └──────────┘   代发结果    └──────────────┘
```

| 段 | 谁发起 | 挂起时间 | 内容 |
|---|---|---|---|
| ① 客户端 → 云 | 客户端 | ≤ 25s（`POLL_HOLD_MS`） | `POST /relay/poll`：提交上行请求、认领结果、收推送 |
| ② 云 ← agent | **agent** | ≤ 20s（`POLL_MS`），云侧空转等 12s | `POST /relay/agent/poll`：取待转发请求、回报结果 |
| ③ agent → 插件 | agent | 30s | `POST /client-api/relay/forward`，本地/内网回环 |

agent 出站连的是云（公网可达），对 OJ 的访问是**本地回环**，不经过任何隧道。

### 为什么 agent 不能省

云服务在公网，它要够到内网 OJ 就必须「暴露端口」或「开隧道」—— 正是被禁的。
agent 的作用是把**出向能力放在内网**：对内网是本地的，对云是出向的。

---

## 三、协议：长轮询，不用 WebSocket

中转站是**零依赖 Node**（只用 `http` / `https` / `crypto` / `fs` / `path` / `url`），
这决定了选型：

| 方案 | 依赖 | 延迟 | 结论 |
|---|---|---|---|
| **长轮询** ✅ | 零 | ≤ 1s | 采用 |
| SSE | 零 | ≤ 1s | 单向，客户端→云还要另开通道 |
| WebSocket | ❌ 要手写 RFC6455 帧解析 | 最低 | 破坏零依赖前提，边界情况多 |

### 一次调用 = 两轮长轮询

```jsonc
// ① 提交：{ token, requests:[{ id, method, path, query, body }] }
//    → { ok, uid, seq, accepted:[id], responses:[], events:[] }
//    · accepted 里没有这个 id = 路径被白名单拒了
//    · 503 + retryAfterMs:2000 = 云还在通过 agent 确认身份，不是失败，等 2s 重发

// ② 认领：{ token, resultIds:[id] }
//    → { ok, uid, seq, accepted:[], responses:[{ id, status, body }], events:[] }
//    · status / body 是**业务接口**的原样响应（状态码透传，不包 200 外壳）
```

参数只走 `query`，POST body 恒 `{}` —— 和客户端原来直连时的 `GatewayAsync` 行为一致。

### 路由

| 方法 | 路径 | 谁调用 |
|---|---|---|
| `POST` | `/relay/poll` | 客户端 |
| `POST` | `/relay/agent/poll` | agent（头 `X-Channel-Key`） |
| `GET` | `/relay/health` | 管理员（agent 在线、队列深度、uid 映射数量） |
| `GET` | `/health` | 存活探针 |

> ⚠️ 云入口必须用 `new URL(req.url, 'http://localhost').pathname` 解析路径。
> .NET `HttpClient` 在 Windows 上走系统代理时，请求行会变成**绝对 URI**
> （`http://host/relay/poll`），裸比较 `req.url === '/relay/poll'` 会全部 404。
> 这个坑只在真实客户端上复现，`curl` 不复现。

---

## 四、身份：uid 代问（云不认得令牌）

云需要按 uid 分桶投递消息，但**只有 OJ 才是令牌的权威**，而云够不到 OJ。
解法：云把「这个令牌是谁」当成一条特殊请求，塞进 agent 队列，请 agent 代问。

```
云 resolveUidByAgent(token)
  → pushRequest('?', { id:'uq<N>', path:'/client-api/auth/whoami', query:{__uidQuery:'1'} }, token)
  → agent 取走 → 插件转发 → 回报 { status, body:{uid} }
  → 云 settleUidQuery() 记住映射
```

**三态约定**（这个区分很关键，搞混会把「网络抖动」误判成「令牌失效」）：

| 返回值 | 含义 | 客户端表现 |
|---|---|---|
| `uid > 0` | 问到了，缓存映射 | 正常放行 |
| `0` | OJ 明确拒绝（401/403） | 返回 `401 令牌无效、已过期或已被撤销` |
| `null` / `-1` | agent 离线 / 超时 / 网络错 | 返回 `503 中转正在确认你的身份，稍后重试`，**不判令牌死刑** |

映射只存 `sha256(令牌)` 前 16 位十六进制 → uid，落盘在 `relay-state/uid-map.json`，
**不存令牌原文**。代问超时 12 秒；agent 断心跳 70 秒算离线。

---

## 五、认证：三方各自怎么信对方

### 5.1 一把密钥，三个位置

> ⚠️ 最容易搞错的一点：**变量名不同，但值是同一串。**

| 位置 | 变量名 / 文件 | 作用 |
|---|---|---|
| 云 | `RELAY_AGENT_KEY` / `relay-agent.key` | 校验 agent 连上来时的 `X-Channel-Key` |
| agent | `--key` / `RELAY_AGENT_KEY_FILE` | 读出来放进 `X-Channel-Key` 头 |
| 插件 | `RELAY_CHANNEL_KEY` / `relay-channel.key` | 校验 agent 打转发接口时的 `X-Channel-Key` |

agent 用**同一个头**同时向云和插件证明身份。云侧比较用「先 sha256 再 `timingSafeEqual`」
（定长 + 常量时间，避免直接用 `timingSafeEqual` 时长度不等抛异常、也避免泄露前缀长度）。

### 5.2 插件侧双验（最终安全边界）

`POST /client-api/relay/forward` 做两件事，**缺一不可**：

1. 验 `X-Channel-Key`（恒定时间）→ 只授予「代发」权限，不能直接调业务接口；
2. `verifyToken(userToken)` 验出真实 uid → **不信任 agent 自报的 uid**。

然后在插件**内部**装配对应业务 handler 并 `dispatch()`：
`HANDLER_MAP` 由 `registerRelayRoute(name, path, Handler, priv)` 在注册路由时顺手维护，
路由名 = `'client_api_' + 路径段用下划线连接`。

转发路径用 `Object.create(HandlerCtor.prototype)` 手工装配假 ctx
（Hydro 的 `Handler` 构造函数签名不稳定，不能 `new`），并设 `_authed = true` 跳过二次鉴权。

**为什么不让 agent 直打业务接口**：那样转发流量和普通流量无法区分，
没有统一的限流 / 审计 / 封禁点。统一入口可以按「通道」（`relay:密钥前缀:IP`）单独开桶，
一个 agent 替全校转发也不按用户数叠加计费。

### 5.3 路径白名单（防 SSRF）

```
/^\/client-api\/[A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_\-]+)*$/
```

明确**不放 `.`**，挡掉 `/client-api/../../etc/passwd`；不放协议头、不放任意 URL。
云侧 `clientPollCore` 和插件侧 `RelayForwardHandler` 各验一遍。

### 5.4 状态码透传

`ClientApiHandler.ok()` 硬编码 `json(200, ...)`，会把业务接口的 404/401/400 包成外层 200，
客户端的 401 重试、错误处理全会瞎。因此新增 `okWithStatus(status, data)`，
转发接口返回 `{ ok:true, status, body }` 信封；agent 拆开信封，只把内层 `{ status, body }` 报回云。

---

## 六、令牌可见性：如实说明

早期设计一度想做到「用户令牌永远不离开插件」，**这条路走不通**，e2e 测试直接证伪：
agent 代问 `whoami` 恒 401，因为请求里根本没有用户令牌。

> **插件只能靠令牌本身确定「你是谁」。令牌在链路上对云和 agent 是可见的，不可避免。**

因此安全模型调整为：

- **agent 必须是自家内网、可信任的进程**（不是随便一台公网 VPS）；
- **云必须 HTTPS**，云侧日志不得记录令牌原文（本实现已遵守）；
- agent 只在内存里短暂持有令牌转发，**不解析、不落盘、不打日志**；
- 通道密钥泄露的最坏情况：攻击者能让 agent「代发」，但**仍需另行拿到有效用户令牌**
  才能以某个用户的身份做事。

---

## 七、离线消息与已知边界

- 云侧按 uid 分桶维护待取队列，`enqueue(uid, type, data)` 分配全局单调 `seq`。
- 客户端下一轮长轮询的 `events` 会取到；C# 侧通过 `HeartbeatRelay.OnEvent` 抛原始 JSON。
- **「取完即清」的短轮询语义，谁取谁负责，不保证重放。**
- ⚠️ **服务端主动推目前没有外部入口**：`server.js` 只挂 4 条路由，`enqueue` 仅
  `module.exports` 导出给测试用，没有带鉴权的投递路由。要真正从外部推消息，需另加一条接口。

| 限制 | 说明 |
|---|---|
| 内存态 | 待转发请求、结果、离线消息都在进程内存，**云重启会丢**；客户端会自动重试 |
| 单实例 | 不要起多个云进程，队列不共享 |
| `RELAY_MSG_TTL_DAYS` | 常量已定义（默认 7），**当前未参与实际过期清理**；靠 `MAX_QUEUE_PER_UID=500` 截断 |
| 单 uid 队列上限 | 500 条，超出丢最旧的 |
| `--oj` 只支持 http | agent 固定用 `http.request`，端口默认 80 |
| 令牌前置条件 | `auth/paircode` / `auth/pair` 依赖网页 cookie 且本身没有令牌，**无法代发**；学生必须先在校园网登录一次 |

---

## 八、改动清单（最终落地位置）

### A. 云中转站

| 文件 | 内容 |
|---|---|
| `relay.js` | 队列、长轮询两个 handler、uid 代问三态、路径白名单、健康检查、状态落盘 |
| `server.js` | 独立零依赖入口（本仓库，**四条路由**：`/relay/poll`、`/relay/agent/poll`、`/relay/health`、`/health`）；维护者本地 `OJSetup/site3/server.js` 里有 `require('./relay')` + 两条长轮询路由，但**发布目录里的线上版本尚未集成**（见第十节） |
| `package.json` | **不需要** |

### B. 内网 agent

`relay-agent/agent.js` —— 零依赖 Node：

- 长轮询 `/relay/agent/poll`，带 `X-Channel-Key`；
- 拿到请求后打插件的 `POST /client-api/relay/forward`（**不直打业务路径**），
  body = `{ userToken, path, method, query, body }`；
- 头必须带 `User-Agent: OjClient/...` —— 站点/Caddy 层有防盗刷，缺了会在插件之前被拦（表现为全部 403）；
- 拆开 `{ ok, status, body }` 信封，只把内层报回云；
- 断线指数退避（上限 30s），**已算好但未回报成功的结果会带着重发**，不丢。

### C. 客户端（WinUI3 + Avalonia 两端）

| 文件 | 改动 |
|---|---|
| `Services/HeartbeatRelay.cs` | **新增**：两轮长轮询、状态码透传、`OnEvent` 推送、70s 总超时 |
| `Services/OjApi.cs` | `GatewayAsync` 开头加分支：`OJ_HEARTBEAT_RELAY=1` 且有令牌时交给 `HeartbeatRelay`，否则原样直连 |

开关：**`OJ_HEARTBEAT_RELAY=1`** 启用，**`OJ_RELAY_URL`** 覆盖中转站根
（默认 `HeartbeatRelay.DefaultRoot = https://sanhaioj-client-beta.app.workbuddy.host`；
真实客户端工程内部用的是 `UpdateChecker.SiteRoot`，值相同）。

> ⚠️ 两端各一份逻辑相同的代码（只差 namespace），改功能必须**两边同步**。
> ⚠️ 本地回环自测要在 `CreateHttp()` 里对 `127.0.0.1` / `localhost` 设 `UseProxy=false`
> （否则 Windows 系统代理会把请求行改成绝对 URI 且连不上回环）；
> **生产域名必须保留系统代理**，学生机器可能得靠代理才能出公网。

参考实现见 `client-example/`。

### D. Hydro 插件 `hydrooj-client-gateway`

**有实质改动**，不是「基本不用改」：

| 文件 | 改动 |
|---|---|
| `handler/base.ts` | `_authed` / `dispatch()` 改 `protected`；新增 `okWithStatus(status, data)` |
| `handler/relay.ts` | **新增** `RelayForwardHandler`（双验、限流、白名单、内部代发）与 `registerRelayRoute` / `HANDLER_MAP` |
| `index.ts` | 所有业务路由改用 `registerRelayRoute` 注册；新增 `ctx.Route('client_api_relay_forward', '/client-api/relay/forward', ...)` |
| `handler/index.ts` | 导出 `./relay` |
| `test/prepare.mjs` | 把 `relay.ts` 加进 `.build` 搬运列表 |
| `test/relay-test.ts` | **新增** 16 项转发安全测试 |

最低版本：提交 **`a5153f2`「心跳转发：新增 /client-api/relay/forward 双验代发路由」**。

### E. 测试结论

| 测试 | 结果 |
|---|---|
| 云 + agent 端到端 `relay-test.cjs` | 12/12 |
| 插件转发安全 `test/relay-test.ts` | 16/16 |
| 插件全量 `test/test.ts` | 293/293 |
| C# 客户端 e2e（两端） | 9/9 |
| 两端 `HeartbeatRelay.cs` 独立编译 | 0 警告 0 错误 |

---

## 九、历史推演修正记录（⚠️ 以下旧说法均已作废）

早期文档里有过这些表述，**都不要照着做**：

| 旧说法 | 为什么错 / 最终改成什么 |
|---|---|
| 「1033 是隧道进程挂了，第一步先查隧道、重启 `cloudflared`」 | 学校**主动关闭**了隧道，是常态。不要修、不要等。整套方案就是为「永远没有隧道」设计的 |
| 「用户令牌永远不会离开插件，agent 根本拿不到用户令牌」 | 走不通：插件只能靠令牌本身认人。最终模型是**令牌对云/agent 可见 + agent 可信 + 双验** |
| 「插件基本不用改，只有两处可选增强」 | 最终新增了 `handler/relay.ts` 整套转发入口、`registerRelayRoute`、`okWithStatus` |
| 「agent 直打业务接口 + `X-Client-Token` 即可」 | 改成统一打 `/client-api/relay/forward`，由插件内部代发，才有统一限流/审计点 |
| 「注册密钥用 `X-Dev-Key`」 | 统一为 **`X-Channel-Key`** |
| 「`OJ_RELAY_BASE` 已有客户端通道开关」 | **本仓库与客户端参考实现里根本没有 `OJ_RELAY_BASE`**（全仓 Grep 仅此一处作废记录）。客户端开关是 `OJ_HEARTBEAT_RELAY=1`，中转站根是 `OJ_RELAY_URL` |
| 「客户端带 `since=<序号>` 补拉」 | 实现是 **`resultIds` 按 id 认领结果** + `events` 取完即清；`since` 未实现 |
| 「转发状态用 `ok()` 返回即可」 | `ok()` 硬编码 200，会盖掉业务状态码；必须用 `okWithStatus()` |
| 「路由名 `'client_api' + 路径段`」 | 少一个下划线会得到 `client_apiping`，所有转发 404；正确是 `'client_api_' + ...` |
| 「路径白名单允许任意 `/client-api/...`」 | 会放过 `../../`，必须限定每段为 `[A-Za-z0-9_-]+` |

---

## 十、当前状态与未完成事项

**已完成（代码 + 测试）**：三段链路、插件双验代发、客户端两端接入、四套测试全绿、
插件仓库推送（`a5153f2`）、本开源仓库组装。

**尚未部署**（都是对外动作，动手前需负责人确认）：

1. 云中转站发布（线上 `site3` 集成 + 密钥配置）；
2. 内网机器安装并常驻 agent；
3. OJ 服务器更新插件到 `a5153f2` 及以后、配 `RELAY_CHANNEL_KEY`；
4. 客户端打包时下发 `OJ_HEARTBEAT_RELAY=1` / `OJ_RELAY_URL`；
5. `1.1.0-dev.52` Linux 版启动崩溃的根因定位（与心跳改动无关，52 产物为 11-02，心跳改动为 11-08）。

逐步命令见 [根目录 README](../README.md)、[发版手册](RELEASE-PLAYBOOK.md)、
[52 崩溃排查](TROUBLESHOOTING-LINUX52.md)。
