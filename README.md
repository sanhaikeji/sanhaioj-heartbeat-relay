# sanhaioj-heartbeat-relay

**心跳式内网中转** —— 学校禁止内网穿透时，用「内网主动外连」替代隧道，让校外的客户端照样访问只在内网的 OJ。

> ## 这份文档是给「照着做」的人看的
>
> 你不需要先理解原理。按 **第 1 章 → 第 7 章** 顺序执行，每章都有可以原样复制的命令和「预期看到什么」。
> 卡住了翻 **第 8 章排障手册**。要发版才看 **第 9 章**（动手前必须先确认）。
>
> - 全部服务端代码**零外部依赖**，只用 Node 内置模块，`npm install` 都不用跑。
> - 涉及 **3 台机器 + 学生电脑**，别在同一台上凑合。
> - 唯一需要你动脑的地方：**一把密钥要放到 3 个地方，值必须完全一样**（第 2 章）。
>
> ### 关于占位符
>
> 公开仓库里的 `<工程目录>` / `<发布目录>` / `<云域名>` / `<appId>` 等是**占位符**，
> 发布时请替换成你的实际值。本仓库维护者本机的真实值集中写在仓库根目录的
> **`LOCAL.md`**（已被 `.gitignore` 忽略，**不会上传 GitHub**）。
> 如果你手上有这份文件，直接照它填即可。

---

## 目录

| 章节 | 内容 | 谁要动手 |
|---|---|---|
| [1. 先搞清楚状况](#1-先搞清楚状况) | 背景、整体顺序、当前部署状态 | 所有人先读 |
| [2. 第 0 步：生成一把密钥](#2-第-0-步生成一把密钥) | 一条命令生成，3 处放置位置 | 管理员 |
| [3. 第 1 台：云中转站](#3-第-1-台云中转站) | 独立部署 / 集成到现有站点 / HTTPS 反代 | 有公网服务器的人 |
| [4. 第 2 台：内网 agent](#4-第-2-台内网-agent) | 学校内网常驻进程、systemd | 能碰 OJ 服务器的人 |
| [5. 第 3 台：Hydro 插件](#5-第-3-台hydro-插件) | 安装 / 更新 / 配密钥 / 自检 | 能碰 OJ 服务器的人 |
| [6. 学生电脑：客户端](#6-学生电脑客户端) | 环境变量、拿令牌、验证、回退 | 教练 / 学生 |
| [7. 端到端验证清单](#7-端到端验证清单) | 逐条打勾，不通过看哪一节 | 管理员 |
| [8. 排障手册](#8-排障手册) | 症状 → 命令 → 处理；含 52 Linux 崩溃 | 卡住时看 |
| [9. 发版 / 发布](#9-发版--发布对外动作动手前必须确认) | 打安装包、更新页、CHANGELOG、回滚 | **必须先确认** |
| [10. 安全模型与已知边界](#10-安全模型与已知边界) | 令牌可见性、双验、限制 | 管理员必读 |
| [11. 测试与最小本地环境](#11-测试与最小本地环境) | 4 套测试、本机跑通三段链路 | 开发者 |
| [12. FAQ / 名词表](#12-faq--名词表) | 常见疑问 | 随时 |

---

## 1. 先搞清楚状况

### 1.1 为什么需要这套东西

OJ 源站在学校内网。学校**不允许内网穿透**（frp / cloudflared 之类），所以 Cloudflare 隧道是被**主动关掉**的。

> ⚠️⚠️ **`error code: 1033` / HTTP 530 是「隧道被主动关闭」的正常表现，不是故障。**
> **不要去重启 `cloudflared`，不要修隧道，不要按「服务挂了」排查。**
> 这条写在最前面，因为它最容易让人白忙一整天。

本方案反过来做：**不让外面连进来，让里面主动连出去。**

```
 外网/学生家              公网                      学校内网
┌──────────┐   ① 长轮询   ┌──────────────┐  ② 长轮询  ┌──────────┐ ③ 本地 HTTP ┌──────────────┐
│  客户端   │ ──────────▶ │  云中转站     │ ◀───────── │ 心跳 agent│ ──────────▶ │ Hydro 插件   │
│          │ ◀────────── │ server.js    │ ─────────▶ │ 常驻进程  │ ◀────────── │ relay/forward│
└──────────┘   响应/推送   └──────────────┘  请求/结果  └──────────┘   代发结果    └──────────────┘
```

三段**全是出向连接**：客户端主动连公网、agent 主动外连公网、agent 本地回环打 Hydro。
**内网不开放任何端口，没有隧道** —— 从防火墙看，agent 和「一台电脑在浏览网页」没区别。

### 1.2 一共要做几件事（严格按顺序）

| 顺序 | 在哪台机器 | 做什么 | 章节 |
|---|---|---|---|
| 0 | 任意一台（管理员电脑即可） | 生成**一把**密钥 | [2](#2-第-0-步生成一把密钥) |
| 1 | 公网服务器 / 现有站点 | 跑起云中转站，配密钥，开 HTTPS | [3](#3-第-1-台云中转站) |
| 2 | 学校内网、能访问 OJ 的机器 | 跑起 agent，配同一把密钥 | [4](#4-第-2-台内网-agent) |
| 3 | OJ 服务器（Hydro） | 装/更新插件，配同一把密钥 | [5](#5-第-3-台hydro-插件) |
| 4 | 学生电脑 | **先在校园网登录一次拿令牌**，再打开中转开关 | [6](#6-学生电脑客户端) |
| 5 | — | 按清单验一遍 | [7](#7-端到端验证清单) |
| 6 | 管理员电脑 | 打安装包 / 更新页面（**对外动作，先确认**） | [9](#9-发版--发布对外动作动手前必须确认) |

> **顺序不能跳**：agent 没起来之前，云侧 `/relay/health` 的 `agentOnline` 永远是 `false`，
> 客户端第一次连接会一直返回 503（云要请 agent 代问「这个令牌是谁」）。

### 1.3 当前部署状态（如实）

| 项 | 状态 |
|---|---|
| 三段链路代码 + 单元/端到端测试 | ✅ 已完成，测试全绿 |
| 插件转发路由（`a5153f2` 起） | ✅ 已推送到 [sanhai-client-gateway](https://github.com/sanhaikeji/sanhai-client-gateway) |
| 客户端 WinUI3 / Avalonia 两端接入 | ✅ 代码已改、独立编译与 e2e 通过，**尚未打包发版** |
| 云中转站线上部署、agent 常驻、插件更新、客户端开关下发 | ⏳ **均未部署**（都是对外动作，需负责人确认） |
| `1.1.0-dev.52` Linux 启动崩溃 | 🔍 根因已定位；**修复方向 A/B 待负责人拍板**，源码已恢复原状，见 [8.3](#83-110-dev52-linux-版启动崩溃) |

### 1.4 三件套 + 两个配套仓库

| 组件 | 文件 | 跑在哪 |
|---|---|---|
| 云中转站 | 本仓库 `server.js` + `relay.js` | 公网可达的 Node 环境 |
| 内网 agent | 本仓库 `relay-agent/agent.js` | 学校内网、能访问 OJ |
| 插件转发入口 | [sanhai-client-gateway](https://github.com/sanhaikeji/sanhai-client-gateway) 的 `handler/relay.ts` | Hydro 插件目录 |
| 客户端参考实现 | 本仓库 `client-example/HeartbeatRelay.cs` | 桌面客户端工程 |

真正的 WinUI3 / Avalonia 两端已经接入完毕，见 [client-example/README.md](client-example/README.md)。

### 1.5 环境要求

- **Node.js ≥ 18**（云和 agent 都是）。零依赖，`npm install` 不需要。
- 云中转站必须有 **HTTPS 域名**（原因见 [10.1](#101-为什么云必须-https)）。
- 内网 agent 要能 `curl http://127.0.0.1:8888/client-api/ping` 通（Hydro 默认 8888，按实际改）。
- 客户端要能出公网访问云域名（学生机器可能走系统代理，代码已兼容）。

---

## 2. 第 0 步：生成一把密钥

> ⚠️ **整套方案只用一把密钥。** 云、agent、插件三处放的**值必须完全一致**（一个字符都不能差，尤其别带换行/空格）。
> 变量名不一样是历史原因，**不是三把不同的钥匙**：
>
> | 位置 | 变量名 / 文件名 | 作用 |
> |---|---|---|
> | 云中转站 | `RELAY_AGENT_KEY` 或 `relay-agent.key` | 校验 agent 连上来时带的 `X-Channel-Key` |
> | 内网 agent | `--key <文件>` / `RELAY_AGENT_KEY_FILE` | 读出来，放进 `X-Channel-Key` 头 |
> | Hydro 插件 | `RELAY_CHANNEL_KEY` 或 `relay-channel.key` | 校验 agent 打转发接口时带的 `X-Channel-Key` |
>
> 插件侧实现在 [sanhai-client-gateway](https://github.com/sanhaikeji/sanhai-client-gateway)，
> 不在本仓库；这里的读取顺序以插件仓库源码为准。

### 2.1 生成（Windows / Linux / macOS 通用，装了 Node 就能跑）

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

会输出一串 64 位十六进制（**下面所有 `<密钥>` 都替换成它**）。
Linux/macOS 也可以用 `openssl rand -hex 32`。

把结果**存进密码管理器**，不要贴进聊天群、不要提交进 git。

### 2.2 三处放置位置（后面各章会用到）

| # | 机器 | 推荐做法 | 具体路径 |
|---|---|---|---|
| 1 | 云 | 写进 systemd 的 `EnvironmentFile` | `/etc/sanhaioj-relay/relay.env` 里 `RELAY_AGENT_KEY=<密钥>` |
| 2 | agent | 独立文件，`chmod 640` | `/etc/sanhaioj-relay/relay-agent.key`（内容只有密钥，无换行） |
| 3 | 插件 | 独立文件 | `<插件目录>/relay-channel.key`（内容只有密钥，无换行） |

写入文件的内容**不要带换行**（`printf %s`），代码里虽然会 `.trim()`，但省得排查：

```bash
sudo install -d -m 0750 /etc/sanhaioj-relay
printf %s '<密钥>' | sudo tee /etc/sanhaioj-relay/relay-agent.key >/dev/null
sudo chown root:relay /etc/sanhaioj-relay/relay-agent.key
sudo chmod 640 /etc/sanhaioj-relay/relay-agent.key
```

`.gitignore` 已经忽略 `*.key` 和 `relay-state/`，**别把它们加进仓库**。

### 2.3 轮换密钥

三处**同时**换，顺序：先云 → 再插件 → 最后 agent（反过来会出现短暂 401，客户端会自动重试，不影响数据）。
改完不用重启客户端。

---

## 3. 第 1 台：云中转站

两种部署方式，**先按 A 在自己机器上跑通，再决定要不要上 B**。

### 3.1 方式 A：独立部署（推荐，先验证）

**① 放文件**

```bash
sudo mkdir -p /opt/sanhaioj-relay/relay-agent /opt/sanhaioj-relay/relay-state
cd /opt/sanhaioj-relay
# 把本仓库的 server.js、relay.js、relay-agent/agent.js 拷进来（或 git clone 后复制）
# git clone https://github.com/sanhaikeji/sanhaioj-heartbeat-relay.git /tmp/ojrelay
# cp /tmp/ojrelay/server.js /tmp/ojrelay/relay.js ./
# cp /tmp/ojrelay/relay-agent/agent.js ./relay-agent/
```

**② 配环境变量文件**

```bash
sudo install -d -m 0750 /etc/sanhaioj-relay
sudo tee /etc/sanhaioj-relay/relay.env >/dev/null <<'EOF'
PORT=8787
RELAY_AGENT_KEY=<密钥>
RELAY_MSG_TTL_DAYS=7
EOF
sudo chmod 600 /etc/sanhaioj-relay/relay.env
```

> `PORT` 不写就是 `8787`。**没配 `RELAY_AGENT_KEY` 时 agent 通道是关闭的**，
> `/relay/health` 会显示 `agentKeyConfigured: false`，agent 连上来一律 503。

**③ 建专用账号 + systemd 服务**

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin relay 2>/dev/null || true
sudo chown -R relay:relay /opt/sanhaioj-relay/relay-state
```

新建 `/etc/systemd/system/oj-relay.service`：

```ini
[Unit]
Description=SanhaiOJ Heartbeat Relay (cloud)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=relay
WorkingDirectory=/opt/sanhaioj-relay
EnvironmentFile=-/etc/sanhaioj-relay/relay.env
ExecStart=/usr/bin/node /opt/sanhaioj-relay/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/sanhaioj-relay/relay-state

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now oj-relay
sudo systemctl status oj-relay --no-pager
```

**④ 立刻验证（本机）**

```bash
curl -s http://127.0.0.1:8787/health
# 预期：{"ok":true,"service":"heartbeat-relay"}

curl -s http://127.0.0.1:8787/relay/health
# 预期：{"ok":true,"service":"sanhaioj-relay","agentOnline":false,
#        "agentLastSeen":null,"agentKeyConfigured":true,
#        "queue":{"uids":0,"messages":0},"pending":0,"results":0,"uidMapSize":0,
#        "note":"隧道 1033 时云直连不到 OJ，uid 映射靠 agent 代问"}
```

`agentOnline: false` 现在是对的 —— agent 还没装（第 4 章）。
`agentKeyConfigured` 必须是 `true`，否则回到第 ② 步。

### 3.2 必须配 HTTPS 反代（生产环境）

**客户端把用户令牌放在 POST body 里发给云**。如果云是裸 HTTP，令牌就是明文过公网。
本地自测可以裸跑，生产必须挂 TLS。Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name relay.example.com;              # 换成你的域名

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # ⚠️ 云侧长轮询会挂住 25 秒：读超时必须大于 25s，否则 nginx 先断
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
        proxy_buffering off;                    # 长轮询别被缓冲
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -s https://<云域名>/relay/health
```

> 反代后面**不要再起第二个云进程**：队列和结果都存在进程内存里，多实例之间不共享。

### 3.3 方式 B：集成进现有零依赖 Node 站点（**本仓库维护者的本地 site3 已有接入代码，线上尚未部署**）

如果现网站点本身就是零依赖 Node，把 `relay.js` 放到 `server.js` 同目录，加三处即可：

```js
const Relay = require('./relay');                                    // 文件头

if (url.pathname === '/relay/poll' && req.method === 'POST') {        // 路由区
  return readBody(req, 1024 * 1024).then((body) => Relay.handleClientPoll(req, res, body));
}
if (url.pathname === '/relay/agent/poll' && req.method === 'POST') {
  return readBody(req, 1024 * 1024).then((body) => Relay.handleAgentPoll(req, res, body));
}
```

另外在站点进程环境里设 `RELAY_AGENT_KEY=<密钥>`（或同目录放 `relay-agent.key`），重启站点，
验证 `GET /relay/health`（可以自行挂到 `Relay.handleHealth(res)`）。

> `getAgentKey()` 是**调用时**读环境变量的，所以「先 require 再设 env」也生效。
> 站点若用 `url.pathname` 解析就没问题 —— **别改回裸比较 `req.url`**，
> 否则走系统代理的 .NET 客户端（请求行是绝对 URI）会全部 404。
>
> ⚠️ **这是对外动作**。按项目约定，站点发布必须先经负责人确认，见第 9 章。

### 3.4 云侧配置表

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 独立入口 `server.js` 的监听端口（集成进现网站点时用站点自己的端口） |
| `RELAY_AGENT_KEY` | 空 | **必配**。为空 = agent 通道关闭。也可以放同目录 `relay-agent.key` |
| `RELAY_MSG_TTL_DAYS` | `7` | 离线消息保留天数（**当前未参与实际过期清理**，见 [10.2](#102-已知边界别过度承诺)） |

### 3.5 云侧路由与超时

| 方法 | 路径 | 谁调用 | 说明 |
|---|---|---|---|
| `POST` | `/relay/poll` | 客户端 | 提交上行请求 / 认领结果 / 收推送，最长挂 25 秒 |
| `POST` | `/relay/agent/poll` | agent | 取待转发请求 / 回报结果，头带 `X-Channel-Key` |
| `GET` | `/relay/health` | 管理员 | 详细健康状态 |
| `GET` | `/health` | 探针 | `{"ok":true,"service":"heartbeat-relay"}` |

`/relay/health` 完整字段：`ok`、`service:"sanhaioj-relay"`、
`agentOnline`（**布尔**，不是在线数）、`agentLastSeen`（毫秒或 `null`）、
`agentKeyConfigured`、`queue:{uids,messages}`、`pending`、`results`、`uidMapSize`、`note`。
**没有「隧道状态」字段**。

| 超时项 | 值 |
|---|---|
| 客户端长轮询挂起 | 25s（`POLL_HOLD_MS`） |
| agent 长轮询挂起 / HTTP timeout | 20s / 35s |
| 云侧空转等 agent 有活 | 12s |
| uid 代问超时 | 12s |
| agent 断心跳多久算离线 | 70s |
| C# 客户端总超时 / 单次 HTTP | 70s / 45s |

---

## 4. 第 2 台：内网 agent

### 4.1 前置检查（在**内网那台机器**上跑）

```bash
node -v                                                        # 必须 >= 18
curl -s -H 'User-Agent: OjClient/1.0' http://127.0.0.1:8888/client-api/ping
# 预期：{"ok":true,"service":"SanhaiOJ 客户端通道", ...}
curl -s https://<云域名>/health                                 # 必须能出公网
```

> 端口 8888 是 Hydro 常见默认值，**以你服务器上实际监听的为准**。
> 站点有防盗刷：UA 必须含 `OjClient`，不带可能被挡在插件之前（表现为「转发全部 403」）。

### 4.2 放密钥（第 2 章那把）

```bash
sudo install -d -m 0750 /etc/sanhaioj-relay
printf %s '<密钥>' | sudo tee /etc/sanhaioj-relay/relay-agent.key >/dev/null
sudo chown root:relay /etc/sanhaioj-relay/relay-agent.key
sudo chmod 640 /etc/sanhaioj-relay/relay-agent.key
```

### 4.3 先手工跑一次（别急着上 systemd）

```bash
node /opt/sanhaioj-relay/relay-agent/agent.js \
  --relay https://<云域名> \
  --key /etc/sanhaioj-relay/relay-agent.key \
  --oj http://127.0.0.1:8888
```

预期输出：

```
[agent] 云=https://<云域名>
[agent] OJ=http://127.0.0.1:8888
[agent] 密钥=/etc/sanhaioj-relay/relay-agent.key（64 字符）
[agent] 心跳正常
```

`Ctrl+C` 停掉，然后**在另一台终端**看云侧：

```bash
curl -s https://<云域名>/relay/health
# agentOnline 应该变成 true（心跳断了 70 秒后会变回 false）
```

### 4.4 做成常驻服务

新建 `/etc/systemd/system/oj-relay-agent.service`：

```ini
[Unit]
Description=SanhaiOJ Heartbeat Relay Agent (intranet)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=relay
WorkingDirectory=/opt/sanhaioj-relay/relay-agent
ExecStart=/usr/bin/node /opt/sanhaioj-relay/relay-agent/agent.js --relay https://<云域名> --key /etc/sanhaioj-relay/relay-agent.key --oj http://127.0.0.1:8888
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now oj-relay-agent
sudo journalctl -u oj-relay-agent -f --no-pager
```

Windows 内网机器可以用 `nssm` 或「任务计划程序」，`ExecStart` 换成
`node.exe <路径>\agent.js --relay ... --key ... --oj ...`。

### 4.5 agent 参数表

| 参数 | 等价环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--relay` | `RELAY_URL` | `https://sanhaioj-client-beta.app.workbuddy.host` | 云中转站根地址，**末尾斜杠会自动去掉** |
| `--key` | `RELAY_AGENT_KEY_FILE` | `relay-agent/relay-agent.key`（脚本同目录） | 密钥**文件路径**（不是密钥内容） |
| `--oj` | `OJ_LOCAL` | `http://127.0.0.1:8888` | OJ 的**本地**地址 |
| `--poll` | — | `20000` | 长轮询挂起毫秒数，无环境变量替代 |

> ⚠️ **`--oj` 只支持 `http://`**（代码里固定用 `http.request`，端口默认 80）。
> 别写 `https://`，也别写域名走公网 —— 它必须是本机/内网回环地址。
>
> agent **不监听任何端口**，只发起出站请求；断线指数退避重连（上限 30 秒），
> 已经算好但没回报成功的结果会带着重发，不会丢。
>
> agent 发给**云**的请求带 `X-Channel-Key`；发给**插件**的请求除 `X-Channel-Key` 外
> 还必须带 `User-Agent: OjClient/1.0 (heartbeat-relay)`（站点/Caddy 防盗刷）。

---

## 5. 第 3 台：Hydro 插件

### 5.1 版本要求（别用旧版）

转发路由 `POST /client-api/relay/forward` 是插件提交 **`a5153f2`「心跳转发：新增 /client-api/relay/forward 双验代发路由」** 之后才有的。
**旧插件没有这个路由，agent 会全部拿到 404。**

```bash
cd <插件目录>
git log -1 --oneline          # 确认包含 a5153f2 或更新
```

### 5.2 首次安装

```bash
cd /root/addon
git clone https://github.com/sanhaikeji/sanhai-client-gateway.git

hydrooj addon add /root/addon/sanhai-client-gateway
pm2 restart hydrooj
```

已有插件就更新：

```bash
cd /root/addon/sanhai-client-gateway && git pull && pm2 restart hydrooj
```

### 5.3 配密钥（第 2 章那把，**同一个值**）

两种任选其一：

```bash
# 方式 1：文件（推荐，密钥不进进程列表）
printf %s '<密钥>' > <插件目录>/relay-channel.key
chmod 600 <插件目录>/relay-channel.key

# 方式 2：环境变量（写进 pm2 的启动环境）
pm2 set hydrooj:RELAY_CHANNEL_KEY '<密钥>'      # 或编辑 ecosystem.config.js 的 env
```

改完必须重启：`pm2 restart hydrooj`。

> 插件读密钥的顺序：先 `process.env.RELAY_CHANNEL_KEY`，没有再读**插件根目录**的 `relay-channel.key`
> （以插件仓库 `handler/relay.ts` 为准）。
> 两个都没配 → 转发接口返回 `503 服务端未配置通道密钥（RELAY_CHANNEL_KEY），转发通道关闭`。

### 5.4 自检（别跳过）

```bash
pm2 logs hydrooj --lines 50 | grep clientgw
curl -s -H 'User-Agent: OjClient/1.0' https://<OJ 内网地址>/client-api/ping
```

装完访问 `/client-api/ping` 应返回：

```json
{ "ok": true, "service": "SanhaiOJ 客户端通道", "timezone": "Asia/Shanghai" }
```

> 如果**所有** `/client-api/*` 都 404，不是转发的问题，是整个插件没加载成功。
> 最常见原因：插件里 import 了 `mongodb` / `schemastery` 这类裸包名 —— Hydro 的三个加载器
> 共用一个 fail 列表，一个文件加载失败会导致**整片路由被跳过**。
> 铁律：插件里只能 import `hydrooj` 和 Node 内置模块。

### 5.5 单独测一下转发接口（在内网机器上）

```bash
curl -s -X POST http://127.0.0.1:8888/client-api/relay/forward \
  -H 'Content-Type: application/json' \
  -H 'X-Channel-Key: <密钥>' \
  -H 'User-Agent: OjClient/1.0 (heartbeat-relay)' \
  -d '{"userToken":"<一个有效用户令牌>","path":"/client-api/auth/whoami","method":"GET","query":{},"body":{}}'
```

预期是**信封**：

```json
{ "ok": true, "status": 200, "body": { "ok": true, "uid": 5, ... } }
```

`status` 是**被代发业务接口**的状态码（透传，不会被包成 200）。
`body` 是业务接口的原始响应。

> ⚠️ 别把真实令牌直接写进命令行（会进 shell history）。测试时用一个临时令牌，
> 或用 `read -s TOKEN` 读进来再拼 JSON，测完在网页「设备管理」里撤销它。

---

## 6. 学生电脑：客户端

### 6.1 ⚠️ 前置：必须先在校园网登录一次

中转站**按令牌认人**，而令牌是客户端在网页登录态下用 `auth/paircode` → `auth/pair` 换来的
（依赖 cookie，且这两步本身没有令牌，**无法代发**）。

所以真实流程是：

1. 学生在**校园网内**打开客户端，正常登录一次（配对码或账号密码），拿到长期令牌（默认 365 天）；
2. 之后回家/校外，打开中转开关，用缓存的令牌走中转。

令牌缓存位置：

| 系统 | 路径 |
|---|---|
| Windows | `%LOCALAPPDATA%\OjClient\gateway.json` |
| Linux | `~/.local/share/OjClient/gateway.json` |
| macOS | `~/Library/Application Support/OjClient/gateway.json` |

> 令牌过期且人在校外时，**只能回校园网重新登录一次**。
> 这不是 bug，是「不给无令牌请求开口子」的代价。

### 6.2 两个开关

| 环境变量 | 值 | 说明 |
|---|---|---|
| `OJ_HEARTBEAT_RELAY` | `1` | 启用中转。**不设 / 设别的值 = 完全走原来的直连，零影响**，这是回退开关 |
| `OJ_RELAY_URL` | `https://<云域名>` | 覆盖中转站根。默认 `https://sanhaioj-client-beta.app.workbuddy.host`；**自建云必须设这个** |

### 6.3 Windows（每台学生机，永久生效）

PowerShell 里执行（普通用户权限即可，不用管理员）：

```powershell
[Environment]::SetEnvironmentVariable('OJ_HEARTBEAT_RELAY', '1', 'User')
[Environment]::SetEnvironmentVariable('OJ_RELAY_URL', 'https://<云域名>', 'User')
```

**然后必须把客户端完全退出再重开**（环境变量只在新进程启动时读取）。

临时试一次（只对这个 cmd 窗口启动的客户端生效）：

```cmd
set OJ_HEARTBEAT_RELAY=1
set OJ_RELAY_URL=https://<云域名>
"<客户端exe>"
```

### 6.4 Linux

**方式 1：用户级 environment.d（推荐，重登后生效）**

```bash
mkdir -p ~/.config/environment.d
cat > ~/.config/environment.d/ojrelay.conf <<'EOF'
OJ_HEARTBEAT_RELAY=1
OJ_RELAY_URL=https://<云域名>
EOF
# 注销并重新登录
```

**方式 2：改 .desktop 启动项（立刻生效，不受登录方式影响）**

```ini
[Desktop Entry]
Exec=env OJ_HEARTBEAT_RELAY=1 OJ_RELAY_URL=https://<云域名> /opt/SanhaiOJ/SanhaiOJ-linux-x64
```

**方式 3：临时试一次**

```bash
OJ_HEARTBEAT_RELAY=1 OJ_RELAY_URL=https://<云域名> ./SanhaiOJ-linux-x64
```

### 6.5 macOS

```bash
launchctl setenv OJ_HEARTBEAT_RELAY 1
launchctl setenv OJ_RELAY_URL 'https://<云域名>'
```

> `launchctl setenv` 重启后失效。要持久就写进启动脚本 / LaunchAgent 的 `EnvironmentVariables`。

### 6.6 打包时内置开关（给全场学生统一开启）

不要挨个机器设环境变量：在**打包/发版**时把 `OJ_HEARTBEAT_RELAY=1` 写进启动包装脚本，
或在客户端设置里加一个「校外模式」开关。保留「直连」作为回退 —— 学生在校园网内直连更快。

### 6.7 怎么确认真的走了中转

- 客户端日志（`%TEMP%\ojclient.log` / `/tmp/ojclient.log`）里出现 `[中转] 收到推送` 或中转相关记录；
- 云侧 `curl https://<云域名>/relay/health` 的 **`uidMapSize` 从 0 变成 ≥1**（有学生连过就说明身份代问成功）；
- agent 日志 `journalctl -u oj-relay-agent -f` 出现 `[agent] 转发 GET /client-api/xxx → 200`；
- 客户端功能（签到、题面、提交列表）正常，且**此时 OJ 公网地址仍然是 1033/530**。

### 6.8 回退到直连（出问题时的第一动作）

删掉 `OJ_HEARTBEAT_RELAY`（或设成 `0`），重启客户端即可，**代码路径完全回到改动前**：

```powershell
[Environment]::SetEnvironmentVariable('OJ_HEARTBEAT_RELAY', $null, 'User')
```

```bash
rm ~/.config/environment.d/ojrelay.conf && # 重新登录
```

---

## 7. 端到端验证清单

从上往下逐条打勾，**任何一条不通过就停下看对应章节**，别往后做。

| # | 检查 | 命令 | 预期 | 不通过看 |
|---|---|---|---|---|
| 1 | 云活着 | `curl -s https://<云>/health` | `{"ok":true,"service":"heartbeat-relay"}` | [3.1](#31-方式-a独立部署推荐先验证) |
| 2 | 云配了密钥 | `curl -s https://<云>/relay/health` | `agentKeyConfigured: true` | [3.1](#31-方式-a独立部署推荐先验证) ② |
| 3 | OJ 插件通 | `curl -s -H 'User-Agent: OjClient/1.0' http://127.0.0.1:8888/client-api/ping` | `{"ok":true,...}` | [5.4](#54-自检别跳过) |
| 4 | 转发路由在 | [5.5](#55-单独测一下转发接口在内网机器上) 的 curl | `{"ok":true,"status":200,"body":{...}}` | [5.1](#51-版本要求别用旧版) |
| 5 | agent 在线 | 启动 agent 后 `curl -s https://<云>/relay/health` | `agentOnline: true` | [4.3](#43-先手工跑一次别急着上-systemd) |
| 6 | 客户端开关生效 | 打开客户端，看云侧 `uidMapSize` | 从 `0` 变成 `≥1` | [6.7](#67-怎么确认真的走了中转) |
| 7 | 业务跑通 | 客户端里签到 / 打开题面 | 正常返回 | [8](#8-排障手册) |
| 8 | 校外可用 | 断开校园网（或用手机热点）重复第 7 步 | 依然正常 | 若直连成功说明开关没生效 |
| 9 | 关掉不崩 | 删掉 `OJ_HEARTBEAT_RELAY` 重启客户端 | 校园网内直连照常 | [6.8](#68-回退到直连出问题时的第一动作) |

**一条命令看完整链路**（agent 日志）：

```bash
sudo journalctl -u oj-relay-agent -f --no-pager &
sudo journalctl -u oj-relay     -f --no-pager &
# 然后让学生在客户端点一下「签到」，两边应该同时出现记录
```

---

## 8. 排障手册

### 8.1 症状速查

| 症状 | 最可能原因 | 马上做的检查 |
|---|---|---|
| 站点返回 `error code: 1033` / HTTP 530 | **Cloudflare 隧道被学校主动关闭，是常态** | **不要修**，这是本方案存在的前提 |
| 客户端所有请求 `503 中转正在确认你的身份` | agent 没在线 / 云问不出 uid | `curl https://<云>/relay/health` 看 `agentOnline`；再看 agent 日志。**503 是「稍后重试」，不是失败**，等 2 秒重发同一条 |
| 客户端 `401 令牌无效、已过期或已被撤销` | 令牌过期 / 撤销 / agent 回报了 401 | 回校园网重新登录一次；[6.1](#61--前置必须先在校园网登录一次) |
| agent 日志 `云服务拒绝：通道密钥不对`（401） | 云侧 `RELAY_AGENT_KEY` 和 agent 的 key 文件**不一致** | 比对两处，注意换行/空格；[2.2](#22-三处放置位置后面各章会用到) |
| agent `503 agent 通道未启用` | 云侧没配密钥 | [3.1](#31-方式-a独立部署推荐先验证) ② |
| 转发接口 `503 服务端未配置通道密钥` | 插件侧没配 `RELAY_CHANNEL_KEY` | [5.3](#53-配密钥第-2-章那把同一个值) |
| 转发全部 `404` | ① 插件是旧版没 `a5153f2`；② 路径不在白名单；③ 路由名没登记 | [5.1](#51-版本要求别用旧版)；路径必须匹配 `/client-api/[A-Za-z0-9_-]+(/...)*` |
| 转发全部 `403` | 缺 `User-Agent: OjClient/...`（Caddy 防盗刷层） | [4.1](#41-前置检查在内网那台机器上跑) |
| **所有** `/client-api/*` 都 404 | 插件整个没加载（import 了裸包名） | `pm2 logs hydrooj`；[5.4](#54-自检别跳过) |
| 中转返回 404 而 curl 正常 | .NET 走系统代理，请求行变绝对 URI | 云入口必须用 `new URL(req.url,'http://localhost').pathname`，别裸比 `req.url` |
| 本地 `127.0.0.1` 自测连不上 / 404 | Windows 上 `HttpClient` 走系统代理 | 客户端已对 loopback 设 `UseProxy=false`；**生产域名别全局关代理** |
| 业务状态码被包成 200 | 用了 `ok()` 而不是 `okWithStatus()` | 插件侧应为 `okWithStatus(r.status, {...})` |
| 首次连接慢 1～2 秒 | 云在请 agent 代问 `whoami`，正常 | 之后走 uid 缓存（只存令牌 sha256 指纹，不存原文） |
| 云进程重启后某些调用超时 | 队列/结果在内存，重启会丢 | 客户端会自动重试；见 [10.2](#102-已知边界别过度承诺) |

### 8.2 日志位置

| 组件 | 位置 / 命令 |
|---|---|
| 云（systemd） | `sudo journalctl -u oj-relay -f --no-pager` |
| 云（手工跑） | 启动那个终端 |
| agent（systemd） | `sudo journalctl -u oj-relay-agent -f --no-pager` |
| Hydro 插件 | `pm2 logs hydrooj --lines 100` |
| 客户端 Windows | `%TEMP%\ojclient.log` |
| 客户端 Linux / macOS | `/tmp/ojclient.log` |
| 云持久化状态 | `<中转站目录>/relay-state/uid-map.json`（只有令牌指纹 → uid，**没有令牌原文**） |

> 客户端日志若停在「`InitializeComponent` 之前」，是 XAML 层崩，跟中转无关，见 [8.3](#83-110-dev52-linux-版启动崩溃)。

### 8.3 `1.1.0-dev.52` Linux 版启动崩溃

> 已确认与心跳中转改动**无关**：52 的产物是 **2026-11-02** 打的，
> 客户端心跳改动是 **2026-11-08**，且 52 的 `deps.json` 里没有新增任何包。

**根因已定位（证据充分）**：dev.52 把托管包 `SkiaSharp` 从 `2.88.9` 升到 **`4.154.0`**，
但随包内嵌的原生 `libSkiaSharp.so` 仍是 **`2.88.9`**（soname `libSkiaSharp.so.88.1.0`）。
与 beta.51 逐项比对，这是 52 **唯一的依赖变更**；托管/原生版本错配导致缺导出符号，
Avalonia 启动第一阶段建 Skia 渲染面时崩溃 → 「运行即崩、无窗口」。
次要问题是 `.deb` 的 `Depends` 没声明 ICU / OpenSSL / Xfixes / GL。

> ⚠️ **修复方向尚未定案，源码已恢复原状**：退回 `2.88.9` 会撞上
> `Controls/LiquidGlassPanel.cs` 里的 SkiaSharp 4.x-only API（`SKRuntimeEffect`）导致编译失败，
> 需同时改功能代码；保持 `4.154.0` 则要显式补齐 `SkiaSharp.NativeAssets.Linux/4.154.0`
> 并做 Linux 真机兼容验证。两条路线的取舍见
> [docs/TROUBLESHOOTING-LINUX52.md 第 6.2 节](docs/TROUBLESHOOTING-LINUX52.md)。
> 路线 B 有一份**未应用**的待命补丁
> [`docs/linux52-routeB.patch`](docs/linux52-routeB.patch)（三处源码改动，
> 已验证 `git apply --check` 可干净应用）；路线 A 没有现成补丁，需另外改功能代码。
> **在修复版发出之前，不要让用户升级到 52 Linux 版**，用下面的回退。

**能立刻做的三件事：**

1. **从终端抓隐藏报错**（图形界面双击看不到任何输出）：
   ```bash
   /usr/bin/sanhaioj-client 2>&1 | tee ~/sanhaioj-run.log; echo "exit=$?"
   # 裸文件版：网站下载的 SanhaiOJ-linux-x64 没有可执行位
   chmod +x ~/Downloads/SanhaiOJ-linux-x64 && ~/Downloads/SanhaiOJ-linux-x64 2>&1 | tee ~/sanhaioj-run.log
   ```
   出现 `libSkiaSharp` / `EntryPointNotFoundException` 即确诊。
2. **回退到 beta.51**（托管与原生都是 2.88.9，已验证可用）：
   ```bash
   sudo apt remove sanhaioj-client
   sudo apt install ./sanhaioj-client_1.1.0-beta.51_amd64.deb
   ```
3. **看日志时注意时间戳**：唯一日志是 `/tmp/ojclient.log`，程序每次启动会**清空重写**，
   且写入发生在 `InitializeComponent()` **之后**。所以「日志里有内容」不等于本次启动成功，
   先核对第一行 banner 的日期时间是不是刚才。

完整逐条排查（图形环境 / ICU / OpenSSL / 单文件自解压 / sha256 校验 / 回退 / 修复方向）
见 **[docs/TROUBLESHOOTING-LINUX52.md](docs/TROUBLESHOOTING-LINUX52.md)**。

> 附带发现：本地 `version.json` 是完好 JSON，但线上返回 HTML「链接不完整」——
> 这是**托管/发布层**问题（漏同步或发成了静态站点），不是生成脚本坏了；
> 自动更新链路失效，只有手动下载 52 的人才升级，所以是「有人反映」而非全量崩溃。
> 见 [发版手册](docs/RELEASE-PLAYBOOK.md) 的发布后抽查。

### 8.4 常见「静默失败」

- MongoDB `updateOne` 匹配不到**不报错** —— 插件自检一定要看 `pm2 logs` 里的 `[clientgw] 自检`。
- 插件 import 裸包名 → 整片 404，不报「插件没装好」。
- 发版从错目录发 → 另建一个应用，页面看着正常但**学生收不到更新**；见 [9](#9-发版--发布对外动作动手前必须确认)。

---

## 9. 发版 / 发布（**对外动作，动手前必须确认**）

> ## ⚠️ 停下来，先确认
> 项目约定：**发版 / 推上线这类对外动作，动手前必须先经负责人确认。**
> 改完代码、跑完测试就停在这里汇报，等点头再发。**`release.py` 不会自动上线**，
> 但一旦手动发布，所有学生的「检查更新」立刻能拉到新版本。

**完整逐步命令（备份 → 出包 → 同步 → 发布 → 抽查 → 回滚）见
[docs/RELEASE-PLAYBOOK.md](docs/RELEASE-PLAYBOOK.md)。** 下面只列最容易翻车的硬约束。

### 9.1 两个目录，别搞混

| 用途 | 占位符 | 说明 |
|---|---|---|
| **工程目录**（代码、`release.py`、产物都在这） | `<工程目录>` | 平时改代码、跑构建脚本的地方 |
| **发布目录**（**只能从这里发**） | `<发布目录>` | 应用 ID 绑定在这个目录上 |

> ⚠️ 应用是按**发布目录路径**认的（`<appId>` 藏在目录里的
> `.wbapp_<appId>.genie` / `.workbuddy/applications.yaml`）。
> 从工程目录里的 `site3` 发布会**另建一个应用** —— 页面能打开，
> 但客户端写死老域名 → 全员「已是最新」= **等于没发，且不报任何错**。
> 本机真实路径见 `LOCAL.md`（不上传 GitHub）。

### 9.2 同步只覆盖 4 项，**绝不整目录复制**

```cmd
robocopy "<工程目录>\site3" "<发布目录>\site3" index.html version.json
robocopy "<工程目录>\site3\download" "<发布目录>\site3\download" /MIR
robocopy "<工程目录>\site3\shots" "<发布目录>\site3\shots" /MIR
```

`/MIR` **只用于 `download\` 和 `shots\` 两个子目录**。
对整个 `site3` 用 `/MIR` 会换掉 `particles3d.js`、覆盖服务端代码，
并**删掉隐藏的 appId 绑定文件和线上 `uploads\` 聊天数据**。
`robocopy` 退出码 0～7 都算成功，**别用 `&&` 串联**。

### 9.3 三个静默失败点

1. `PREV_VERSION` 在 `make-page.py` 里是**硬编码**的（默认 `1.1.0-beta.51`），
   `release.py` **不会替你改**。不改 → 页面仍并排旧版、找不到时静默隐藏旧版入口。
   每次发版要手动改成当前线上版本，或在重出页面时传 `--prev=<上一版>`。
2. 要保留上一版安装包，必须在归档前 `add` 进 `placed` 集合；否则被 `os.replace`
   挪进 `_stale\`，只打印一句提示，**不报错、不中止**。
3. `version.json` 漏同步 → 线上返回 HTML「链接不完整」，客户端 `JsonDocument.Parse` 抛异常被吞，
   学生端点「检查更新」**静默无反应**。

### 9.4 常用命令（确认后执行）

```cmd
cd /d "<工程目录>"
python release.py <版本号>                 :: 全量，约 16 分钟，不会自动上线
python release.py <版本号> --only-page     :: 只重出页面（不重新编译）
python release.py <版本号> --only-win      :: 只重出 Windows 安装包 + 页面
```

> ⚠️ **`--only-linux` 无效**：它只改进度分母，不跳过任何步骤，仍跑完整流程（会打印 `[5/4]`）。不要用。
> 更新日志在 `make-page.py` 的 `CHANGELOG`，**往头部插** `(标题, 描述, True[, 配图])`。
> `python verify-install.py <版本号>` 有真实本机副作用（会安装、改注册表、启动截图、再卸载），别当纯检查。

发布后必须抽查 `curl -i https://<线上域名>/version.json` 首字节是 `{`、
`download/` 直链 200、`/health` 的 `uploads` / `feedback` 数量不比发布前少。

**发版前的产物检查（建议固化进流程）**：

- 确认 `SkiaSharp` 与 `SkiaSharp.NativeAssets.Linux` 版本一致（见 [8.3](#83-110-dev52-linux-版启动崩溃)）；
- 在**干净 Linux 虚拟机**里真启动一次新包（不是只看文件存在）；
- 免安装单文件 `SanhaiOJ-linux-x64` 要带可执行位，或在下载页写明 `chmod +x`；
- 核对产物里的 `AssemblyInformationalVersion` 与 `version.json` 的版本号一致
  （**预防性核对项**；dev.52 实测 `-p:Version` 覆盖已生效，不是既成故障）。

### 9.5 推 GitHub

在仓库目录执行（**这是推源码，不是站点发布**）：

```bash
git add -A && git commit -m "docs: 完整操作手册"
git -c http.version=HTTP/1.1 push -u origin main
```

> 本机有专用推送脚本与额外参数（真实命令见 `LOCAL.md`，不写进公开仓库）。
> 公开仓库请自行配置凭据；不要把 PAT / 密钥 / 本机路径写进 README。

---

## 10. 安全模型与已知边界

### 10.1 为什么云必须 HTTPS

用户令牌放在 `POST /relay/poll` 的 body 里给云。**令牌在链路上对云和 agent 是可见的** ——
这不可避免：插件只能靠令牌本身确定「你是谁」，不信任 agent 自报 uid。

因此：

- **agent 必须部署在自家可信的内网机器上**（不是随便找台公网 VPS）；
- **云必须 HTTPS**，且云侧日志不得记录令牌原文（本实现已遵守：状态文件只存 `sha256(令牌)` 前 16 位十六进制 → uid）；
- agent 只在内存里短暂持有令牌转发，**不解析、不落盘、不打日志**。

### 10.2 已知边界（别过度承诺）

| 限制 | 说明 |
|---|---|
| 内存态队列 | 待转发请求、结果、离线消息**只在进程内存**，云重启会丢。正在进行的调用会超时并由客户端重试 |
| 单实例 | 不要起多个云进程，队列不共享 |
| 消息不保证重放 | `events` 是「取完即清」的短轮询语义，谁取谁负责 |
| **服务端主动推暂无外部入口** | `enqueue(uid, type, data)` 只导出给测试用，`server.js` 只挂 4 条路由、**没有投递接口**；目前只能在进程内部调用。要对外推消息需另加一条带鉴权的投递路由 |
| `RELAY_MSG_TTL_DAYS` | 常量已定义（默认 7），**当前未参与实际过期清理**；靠队列上限 `MAX_QUEUE_PER_UID=500` 截断 |
| `MAX_BACKFILL` | 定义了但全仓无使用点 |
| `--oj` 只支持 http | agent 固定用 `http.request`，端口默认 80 |
| 一把密钥复用两处 | 云和插件校验的是**同一个值**；要拆成两把需改 `agent.js` 分别读取 |

### 10.3 防线（插件侧）

- **双验**：`X-Channel-Key`（恒定时间比较：先 sha256 再 `timingSafeEqual`）只授「代发」权限；
  `verifyToken(userToken)` 验出真实 uid。两者缺一不可。
- **路径白名单**：只放行 `/client-api/[A-Za-z0-9_-]+(/...)*`，挡住 `..` 与任意 URL（防 SSRF）。
- **状态码透传**：用 `okWithStatus()` 而不是 `ok()`，业务接口的 404/401/400 原样回给客户端，
  否则上层的 401 重试、错误处理全会瞎。
- **路由表**：`registerRelayRoute()` 同时注册 Hydro 路由和维护 `HANDLER_MAP`；
  路由名 = `'client_api_' + 路径段用下划线连接`（早期少一个下划线，导致所有转发 404）。
- **限流**：转发流量按「通道」单独开桶，不按用户数叠加计费。

> 通道密钥泄露的最坏情况：攻击者能让 agent「代发」，但**仍需另行拿到有效用户令牌**
> 才能以某个用户的身份做事。轮换 = 三处同时换。

---

## 11. 测试与最小本地环境

### 11.1 四套测试

| 测试 | 在哪 | 命令 | 结果 |
|---|---|---|---|
| 云 + agent 端到端 | **本仓库** | `node relay-test.cjs` | **12/12 通过**（实测 4.6s，stderr 无警告） |
| 插件转发安全（密钥 / 路径 / 撤销 / 状态码） | [sanhai-client-gateway](https://github.com/sanhaikeji/sanhai-client-gateway) | `test/relay-test.ts` | 16/16 |
| 插件全量回归 | 同上 | `test/test.ts` | 293/293 |
| C# 客户端 e2e（WinUI3 + Avalonia 两端） | 客户端工程 | 独立测试工程 | 9/9 |

> 后三套的测试文件**不在本仓库**，本仓库只能复核第一套。
> `relay-test.cjs` 直接驱动 `relay.js` 的真实 handler（自己起薄壳 HTTP），
> **不经过 `server.js` 路由层**；客户端侧走 `handleClientPollForTest`（直接调 `clientPollCore`）。
> 它真起 `agent.js` 进程 + 假 OJ 模拟转发信封，覆盖：uid 代问、请求转发与结果认领、
> 无效令牌（401 且**不入队**）、错密钥 agent 被拒。
>
> 测试用的 `.key` 文件写在 `os.tmpdir()`（写仓库内会 `EPERM`），`.gitignore` 已忽略 `*.key`。
> 运行时 `relay.js` 会往仓库根写 `relay-state/uid-map.json`，已忽略；推 GitHub 前可删掉。
>
> 注：本仓库的 `relay.js` / `relay-agent/agent.js` 与本地 `OJSetup/site3` 的版本**逐字节相同**；
> 只有 `relay-test.cjs` 不同（本仓库版把测试密钥写到系统临时目录，site3 版写在仓库内）。

### 11.2 本机跑通完整三段链路（实测可照抄）

以下命令在 **Linux / macOS 或 Windows 的 Git Bash** 下执行。
需要 **4 个终端**。每个终端开头都重新算一次 `TMP`，互不依赖。

**准备（一次）**：

```bash
export TMP="$(node -e "process.stdout.write(require('os').tmpdir())")"
export KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
printf %s "$KEY" > "$TMP/relay-agent.key"
echo "密钥=$KEY   密钥文件=$TMP/relay-agent.key"

cat > "$TMP/fake-oj.cjs" <<'FAKEOJ'
// 模拟插件 POST /client-api/relay/forward（双验：通道密钥 + 用户令牌）
const http = require('http');
const KEY = process.env.FAKE_OJ_KEY || '';
const PORT = Number(process.env.FAKE_OJ_PORT || 18888);
const TOKENS = new Map([['demo-user-token-abcdef', 42]]);
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let p = {}; try { p = JSON.parse(body || '{}'); } catch {}
    const send = (code, obj) => {
      const b = Buffer.from(JSON.stringify(obj), 'utf8');
      res.writeHead(code, {'Content-Type':'application/json','Content-Length':b.length});
      res.end(b);
    };
    if (req.url !== '/client-api/relay/forward') return send(404, {ok:false,error:'没有这个接口'});
    if (String(req.headers['x-channel-key']||'') !== KEY) return send(401,{ok:false,error:'通道密钥不对'});
    const uid = TOKENS.get(p.userToken);
    if (!uid) return send(401,{ok:false,error:'用户令牌无效、已过期或已被撤销'});
    return send(200,{ok:true,status:200,body:{ok:true,uid,echoPath:p.path}});
  });
}).listen(PORT,'127.0.0.1',()=>console.log('[fake-oj] listening on '+PORT));
FAKEOJ
```

**终端 A · 云**（在本仓库根目录）：

```bash
export TMP="$(node -e "process.stdout.write(require('os').tmpdir())")"
PORT=8787 RELAY_AGENT_KEY="$(cat "$TMP/relay-agent.key")" node server.js
```

**终端 B · 假 OJ**：

```bash
export TMP="$(node -e "process.stdout.write(require('os').tmpdir())")"
FAKE_OJ_KEY="$(cat "$TMP/relay-agent.key")" FAKE_OJ_PORT=18888 node "$TMP/fake-oj.cjs"
```

**终端 C · 内网 agent**：

```bash
export TMP="$(node -e "process.stdout.write(require('os').tmpdir())")"
node relay-agent/agent.js --relay http://127.0.0.1:8787 \
  --key "$TMP/relay-agent.key" --oj http://127.0.0.1:18888
```

**终端 D · 验证**：

```bash
BASE=http://127.0.0.1:8787
curl -sS $BASE/health
curl -sS $BASE/relay/health
curl -sS -X POST $BASE/relay/poll -H 'Content-Type: application/json' -d '{}'
curl -sS -X POST $BASE/relay/poll -H 'Content-Type: application/json' \
  -d '{"token":"demo-user-token-abcdef","requests":[{"id":"q1","method":"GET","path":"/client-api/auth/whoami"}]}'
curl -sS -X POST $BASE/relay/poll -H 'Content-Type: application/json' \
  -d '{"token":"demo-user-token-abcdef","resultIds":["q1"]}'
curl -sS -X POST $BASE/relay/poll -H 'Content-Type: application/json' \
  -d '{"token":"bad-token","requests":[{"id":"q2","method":"GET","path":"/client-api/auth/whoami"}]}'
curl -sS -X POST $BASE/relay/agent/poll -H 'Content-Type: application/json' \
  -H 'X-Channel-Key: wrong-key' -d '{}'
curl -sS $BASE/nope
```

**预期返回（均为实测真实值）**：

| 命令 | 预期 |
|---|---|
| `/health` | `{"ok":true,"service":"heartbeat-relay"}` |
| `/relay/health` | `agentOnline:true`、`agentKeyConfigured:true`、`queue":{"uids":0,"messages":0}`、`uidMapSize:0` |
| 缺令牌 | HTTP **401** `{"ok":false,"error":"缺少令牌"}` |
| 提交 | `{"ok":true,"uid":42,"seq":0,"accepted":["q1"],"responses":[],"events":[]}` |
| 认领 | `responses:[{"id":"q1","status":200,"body":{"ok":true,"uid":42,"echoPath":"/client-api/auth/whoami"}}]` |
| 无效令牌 | HTTP **401** `{"ok":false,"error":"令牌无效、已过期或已被撤销"}` |
| 错密钥 | HTTP **401** `{"ok":false,"error":"通道密钥不对"}` |
| `/nope` | HTTP **404** `{"ok":false,"error":"没有这个路由"}` |

> ⚠️ **首次提交若返回 503** `{"ok":false,"error":"中转正在确认你的身份，稍后重试","retryAfterMs":2000}`
> 是**正常**的（云正在通过 agent 代问 uid），等 2 秒重发同一条即可；C# 客户端会自动重试 8 次。
> 端口 8787 若被占用就改 `PORT`。
>
> 想验证「系统代理产生绝对 URI 请求行」的场景，可以手工发
> `GET http://127.0.0.1:8787/health HTTP/1.1` —— 实测仍返回 200，
> 证明 `server.js` 的 `new URL(req.url, 'http://localhost').pathname` 解析是必要的。

### 11.3 客户端协议（两轮长轮询）

```jsonc
// ① 提交
POST /relay/poll
{ "token": "<OJ 用户令牌>",
  "requests": [{ "id": "q1", "method": "GET", "path": "/client-api/checkin/status", "query": {}, "body": {} }] }
// → { ok, uid, seq, accepted: ["q1"], responses: [], events: [] }

// ② 认领结果
POST /relay/poll
{ "token": "<OJ 用户令牌>", "resultIds": ["q1"] }
// → { ok, uid, seq, accepted: [], responses: [{ "id":"q1", "status":200, "body": {...} }], events: [] }
```

> **路径不在白名单时，云仍返回 HTTP 200**，只是 `accepted` 里没有你的 id（例如
> `/client-api/../../etc/passwd` 实测 `accepted:[]`）。
> `400 中转站拒收该请求` 是 **C# 客户端自己合成的**（`HeartbeatRelay.cs` 检查 `accepted`），
> 不是云返回的。
>
> `503` + `retryAfterMs: 2000` = 云还在确认身份，不是失败，等 2 秒重发。

---

## 12. FAQ / 名词表

**Q：能不能不装 agent，让云直接连 OJ？**
不能。云在公网，要够到内网 OJ 就得「暴露端口 / 开隧道」，正是学校禁的。agent 的价值就是把出向能力放在内网。

**Q：`1033` 什么时候会好？**
不会好，也不该等。隧道是被主动关掉的，本方案就是为「永远没有隧道」设计的。

**Q：学生校外第一次打开客户端，没登录过，能用吗？**
不能。必须先回校园网登录一次拿令牌（[6.1](#61--前置必须先在校园网登录一次)）。

**Q：三处密钥能不能用三把不同的？**
当前实现不行：agent 只用一个 `CHANNEL_KEY` 同时发给云和插件。要拆成两把得改 `agent.js`。

**Q：中转会影响校园网内的速度吗？**
会多一跳。所以建议**保留直连作为默认**，只在需要时开 `OJ_HEARTBEAT_RELAY=1`。

**Q：为什么用长轮询不用 WebSocket？**
云站是零依赖 Node，WebSocket 要手写 RFC6455 帧解析，边界情况多。长轮询挂 25 秒，有消息立刻返回，几十个学生完全够用。

**Q：能不能推消息给学生？**
`enqueue(uid, type, data)` 和 `events` 机制都在，但**当前 `server.js` 没有对外投递路由**
（只挂了 4 条路由，`enqueue` 只导出给测试）。要真正从外部推消息，需要另加一条带鉴权的投递接口。

| 名词 | 含义 |
|---|---|
| 通道令牌 / 用户令牌 | 客户端登录 OJ 后拿到的长期令牌（默认 365 天），插件靠它认人 |
| 通道密钥 | 本方案那一把 `X-Channel-Key`，证明「我是自家 agent」 |
| uid 代问 | 云不认得令牌是谁，首次连接请 agent 打 `/client-api/auth/whoami` 问出来并缓存 |
| 转发信封 | 插件返回的 `{ ok, status, body }`，agent 拆开后只把内层 `status/body` 报回云 |
| `a5153f2` | 插件加入转发路由的那次提交，旧版没有 `/client-api/relay/forward` |

---

## 相关文档

- [docs/HEARTBEAT-RELAY-DESIGN.md](docs/HEARTBEAT-RELAY-DESIGN.md) —— 设计动机、协议细节、历史推演修正记录
- [docs/RELEASE-PLAYBOOK.md](docs/RELEASE-PLAYBOOK.md) —— 发版 / 发布 / 回滚逐步命令
- [docs/TROUBLESHOOTING-LINUX52.md](docs/TROUBLESHOOTING-LINUX52.md) —— 52 Linux 启动崩溃排查
- [docs/linux52-routeB.patch](docs/linux52-routeB.patch) —— 52 路线 B 待命补丁（**未应用**，应用/回退命令见排障文档 6.2）
- [client-example/README.md](client-example/README.md) —— 客户端接入
- [sanhai-client-gateway](https://github.com/sanhaikeji/sanhai-client-gateway) —— Hydro 插件

## License

[MIT](LICENSE)
