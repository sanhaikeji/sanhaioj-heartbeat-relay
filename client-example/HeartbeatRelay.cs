using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace SanhaiOj.Relay;

/// <summary>
/// 心跳中转的**客户端传输层**（2026-11-08）。
///
/// <para>背景：学校禁止内网穿透，OJ 源站只在内网可达，外网直连必然失败。
/// 客户端把 <c>/client-api/*</c> 调用交给云中转站的长轮询接口，由内网 agent 取走、
/// 打给插件的转发入口。三段全是出向连接，内网不开放任何端口。</para>
///
/// <para>协议（云侧 <c>POST /relay/poll</c>）：
///   ① 提交：<c>{ token, requests:[{ id, method, path, query, body }] }</c> → 拿 <c>accepted</c>；
///   ② 认领：<c>{ token, resultIds:[id] }</c> → <c>responses:[{ id, status, body }]</c>。</para>
///
/// <para>⚠️ **只在有通道令牌时启用**：配对（<c>auth/paircode</c>、<c>auth/pair</c>）
/// 靠网页 cookie、还没有令牌，而中转站是按令牌认人的 —— 这两步无法代发。
/// 所以部署上是「学生在校园网内登录一次客户端拿到 365 天令牌，之后回家走中转」。</para>
///
/// <para>开关：<c>OJ_HEARTBEAT_RELAY=1</c> 启用；<c>OJ_RELAY_URL</c> 覆盖中转站根
/// （默认 <see cref="DefaultRoot"/>，本地自测可指到 <c>http://127.0.0.1:8787</c>）。</para>
/// </summary>
public static class HeartbeatRelay
{
    /// <summary>线上中转站根，换成你自己的部署地址。</summary>
    public const string DefaultRoot = "https://sanhaioj-client-beta.app.workbuddy.host";

    /// <summary>日志出口。真实工程里接到自己的 Log.W；不设就静默。</summary>
    public static Action<string> Trace = _ => { };

    /// <summary>是否走中转。关掉时 <c>GatewayAsync</c> 保持原来的直连行为，零影响。</summary>
    public static bool IsEnabled =>
        string.Equals(Environment.GetEnvironmentVariable("OJ_HEARTBEAT_RELAY"), "1", StringComparison.Ordinal);

    private static string Root
    {
        get
        {
            var s = Environment.GetEnvironmentVariable("OJ_RELAY_URL");
            return string.IsNullOrWhiteSpace(s) ? DefaultRoot : s.Trim().TrimEnd('/');
        }
    }

    // ⚠️ 独立 HttpClient：云侧长轮询会挂住 25s，主 _http 的 30s 超时不够，
    //    而且「发过请求后 Timeout 属性锁死」，不能改共享的那个。
    private static readonly HttpClient Http = CreateHttp();

    private static HttpClient CreateHttp()
    {
        // ⚠️ 本地自测（OJ_RELAY_URL 指到 127.0.0.1）必须绕开系统代理：
        //    代理不会把请求转发到本机回环，还会把请求行改成绝对 URI（服务端会 404）。
        //    但**生产域名照常走系统代理** —— 学生机器可能必须靠代理才能出公网。
        var handler = new HttpClientHandler();
        if (Uri.TryCreate(Root, UriKind.Absolute, out var u)
            && (u.IsLoopback || string.Equals(u.Host, "localhost", StringComparison.OrdinalIgnoreCase)))
        {
            handler.UseProxy = false;
        }
        var h = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(45) };
        h.DefaultRequestHeaders.UserAgent.ParseAdd("OjClient/1.0 (heartbeat-relay)");
        h.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return h;
    }

    /// <summary>
    /// 服务端推送（离线期间攒的事件）。参数是原始 JSON 字符串，UI 层可自行订阅。
    /// <para>不订阅也不影响：现有 UI 本来就有 5 秒消息轮询，这里只多一条更快的通道。</para>
    /// </summary>
    public static event Action<string>? OnEvent;

    /// <summary>
    /// 发一次通道调用，返回 <b>业务接口</b>的状态码和 JSON 正文（与直连时的
    /// <c>GatewayAsync</c> 完全同构，调用方无需区分）。
    /// </summary>
    public static async Task<(int Status, string Body)> SendAsync(
        HttpMethod method, string path, IDictionary<string, string?>? query, string token)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(70));
        var id = "c" + Guid.NewGuid().ToString("N");

        // 参数只走 query（跟直连时一致：GatewayAsync 的 POST body 恒为 {}）。
        var q = new Dictionary<string, string>();
        if (query != null)
            foreach (var kv in query)
                if (!string.IsNullOrEmpty(kv.Value)) q[kv.Key] = kv.Value!;

        var request = new
        {
            id,
            method = method.Method,
            path,
            query = q,
            body = new Dictionary<string, object>(),   // 恒 {}，见上
        };

        // ---------------------------------------------------------- ① 提交
        // 503 = 中转站还在通过 agent 确认身份（首次连接），不是失败，等一下重发。
        bool submitted = false;
        for (int attempt = 0; attempt < 8 && !cts.IsCancellationRequested; attempt++)
        {
            var (code, text) = await Post(new { token, requests = new[] { request } }, cts.Token);
            if (code == 503)
            {
                await Task.Delay(2000, cts.Token).ContinueWith(_ => { }, TaskScheduler.Default);
                continue;
            }
            if (code != 200) return (code, text);

            try
            {
                using var doc = JsonDocument.Parse(text);
                var r = doc.RootElement;
                if (!r.TryGetProperty("ok", out var okEl) || okEl.ValueKind != JsonValueKind.True)
                    return (401, text);     // 令牌无效 / 被撤销，让上层走 401 重试
                if (r.TryGetProperty("accepted", out var acc) && !ContainsId(acc, id))
                    return (400, "{\"ok\":false,\"error\":\"中转站拒收该请求（路径不合法？）\"}");
                HandleEvents(r);
                submitted = true;
                break;
            }
            catch (JsonException)
            {
                return (502, "{\"ok\":false,\"error\":\"中转站返回的不是 JSON\"}");
            }
        }
        if (!submitted)
            return (503, "{\"ok\":false,\"error\":\"中转站暂时不可用（身份确认超时）\"}");

        // ---------------------------------------------------------- ② 认领结果
        // 云侧在结果到达前会挂住这一轮（waitForWork 被 agent 的回报唤醒），
        // 所以正常情况第二轮就能拿到；这里的循环只用于网络抖动后重发。
        for (int i = 0; i < 12 && !cts.IsCancellationRequested; i++)
        {
            var (code, text) = await Post(new { token, resultIds = new[] { id } }, cts.Token);
            if (code == 503)
            {
                await Task.Delay(1000, cts.Token).ContinueWith(_ => { }, TaskScheduler.Default);
                continue;
            }
            if (code != 200) return (code, text);

            try
            {
                using var doc = JsonDocument.Parse(text);
                var r = doc.RootElement;
                HandleEvents(r);
                if (r.TryGetProperty("responses", out var arr) && arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in arr.EnumerateArray())
                    {
                        if (!item.TryGetProperty("id", out var idEl) || idEl.GetString() != id) continue;
                        int st = item.TryGetProperty("status", out var sEl) && sEl.TryGetInt32(out var v) ? v : 200;
                        string body = item.TryGetProperty("body", out var bEl) ? bEl.GetRawText() : "{}";
                        if (string.IsNullOrWhiteSpace(body) || body == "null") body = "{}";
                        // ⚠️ 状态码**透传**：业务接口回 404/401 就是 404/401，
                        //    包成 200 的话 ClientGateway 的 401 重试、错误处理全都会瞎。
                        return (st, body);
                    }
                }
            }
            catch (JsonException)
            {
                return (502, "{\"ok\":false,\"error\":\"中转站返回的不是 JSON\"}");
            }

            await Task.Delay(200, cts.Token).ContinueWith(_ => { }, TaskScheduler.Default);
        }
        return (504, "{\"ok\":false,\"error\":\"中转等待结果超时\"}");
    }

    // ---------------------------------------------------------------- 内部

    private static async Task<(int Status, string Body)> Post(object payload, CancellationToken ct)
    {
        try
        {
            var json = JsonSerializer.Serialize(payload);
            using var content = new StringContent(json, Encoding.UTF8, "application/json");
            using var resp = await Http.PostAsync(Root + "/relay/poll", content, ct);
            var text = await resp.Content.ReadAsStringAsync(ct);
            return ((int)resp.StatusCode, text);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // 单次 HTTP 超时（45s）—— 让外层重试，别把整个调用判死
            return (503, "{\"ok\":false,\"error\":\"中转轮询超时\"}");
        }
        catch (Exception ex)
        {
            Trace("[中转] 请求失败：" + ex.Message);
            return (0, "{\"ok\":false,\"error\":\"中转站不可达\"}");
        }
    }

    private static bool ContainsId(JsonElement arr, string id)
    {
        if (arr.ValueKind != JsonValueKind.Array) return false;
        foreach (var e in arr.EnumerateArray())
            if (e.ValueKind == JsonValueKind.String && e.GetString() == id) return true;
        return false;
    }

    private static void HandleEvents(JsonElement root)
    {
        if (!root.TryGetProperty("events", out var arr) || arr.ValueKind != JsonValueKind.Array) return;
        foreach (var e in arr.EnumerateArray())
        {
            var raw = e.GetRawText();
            Trace("[中转] 收到推送：" + (raw.Length > 160 ? raw[..160] + "…" : raw));
            try { OnEvent?.Invoke(raw); } catch { /* UI 订阅者自己的锅，不能拖垮传输层 */ }
        }
    }
}
