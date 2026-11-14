# 客户端接入参考实现

`HeartbeatRelay.cs` 是从真实桌面客户端（C# / .NET 8）里抽出来的传输层，自包含、零外部依赖。
WinUI3（Windows）和 Avalonia（Linux/macOS）两端用的是**同一份代码**，只差命名空间。

## 接法

把它加进工程，然后在原本「直连 OJ」的通道方法开头加一个分支：

```csharp
public async Task<(int Status, string Body)> GatewayAsync(
    HttpMethod method, string path,
    IDictionary<string, string?>? query = null, string? token = null)
{
    if (HeartbeatRelay.IsEnabled)
    {
        // 没令牌的调用（ping / auth/paircode / auth/pair）不能代发：
        // 中转站按令牌认人，配对还依赖网页 cookie。
        if (string.IsNullOrEmpty(token))
            return (401, "{\"ok\":false,\"error\":\"中转模式下需要通道令牌\"}");
        return await HeartbeatRelay.SendAsync(method, path, query, token);
    }

    // ……原来的直连代码，一行都不用改……
}
```

`SendAsync` 返回的 `(status, body)` 与直连完全同构：状态码是**业务接口**的（透传，不包 200 外壳），
`body` 是业务接口的原始 JSON 文本。所以上层解析、401 重试、错误处理全都照旧。

日志接到自己的日志器：

```csharp
HeartbeatRelay.Trace = s => Log.W(s);
```

## 开关

| 环境变量 | 作用 |
|---|---|
| `OJ_HEARTBEAT_RELAY=1` | 启用中转。不设 / 设别的值 = 完全走原来的直连，**零影响** |
| `OJ_RELAY_URL` | 覆盖中转站根地址。默认 `DefaultRoot`，本地自测可指到 `http://127.0.0.1:8787` |

部署方式是给客户端打包时把 `OJ_HEARTBEAT_RELAY=1` 写进启动环境，或者在设置里加一个开关。
建议保留「直连」作为回退：学生在校园网内时能直连，回家才需要中转。

## 两个必须知道的边界

1. **要先有令牌**。中转站按令牌确认身份，而令牌是客户端在网页登录态下用
   `auth/paircode` → `auth/pair` 换来的（依赖 cookie，且这两步本身没有令牌）。
   所以实际流程是：**学生在校园网内登录一次拿到长期令牌（默认 365 天），之后回家走中转**。
   令牌过期且人在校外时，只能回校园网重新登录一次 —— 这不是 bug，是「不给无令牌请求开口子」的代价。

2. **本地回环不走系统代理**。`CreateHttp()` 里对 `127.0.0.1` / `localhost` 关掉了代理：
   代理不会把请求转发到本机回环，还会把请求行改成绝对 URI（服务端会 404）。
   但**生产域名照常走系统代理** —— 学生机器可能必须靠代理才能出公网，别全局禁用。

## 服务端推送

`events` 数组里是离线期间攒的消息，通过 `HeartbeatRelay.OnEvent` 抛原始 JSON 字符串。
不订阅也没关系：现有 UI 通常本来就有消息轮询，这只是多一条更快的通道。

```csharp
HeartbeatRelay.OnEvent += json => { /* 更新未读徽标 */ };
```

## 验证

仓库根目录的 `node relay-test.cjs` 会真起 `agent.js` 进程 + 假 OJ 跑通三段链路，
但它**直接驱动 `relay.js` 的真实 handler**（自己起薄壳 HTTP），**不经过 `server.js` 路由层**；
客户端侧走 `handleClientPollForTest`（直接调 `clientPollCore`）。
要把路由层、真 agent、curl 一起验，见 [根 README 第 11.2 节](../README.md#112-本机跑通完整三段链路实测可照抄)。
客户端这一段可以用一个最小 C# 测试工程直接 include 本文件，把 `OJ_RELAY_URL` 指到本地
server.js，再断言 `SendAsync` 返回的状态码/正文/query 透传（WinUI3 与 Avalonia 两端都要验）。
