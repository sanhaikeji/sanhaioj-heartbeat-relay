# 发版 / 发布手册（照抄执行）

> **本机 Windows，所有命令在「命令提示符 cmd」里执行。**
>
> | 用途 | 占位符 | 说明 |
> |---|---|---|
> | **工程目录**（改代码、跑脚本、产物） | `<工程目录>` | 平时改代码、跑构建脚本的地方 |
> | **客户端源码目录** | `<客户端源码目录>` | Avalonia/Linux 客户端工程，与 `<工程目录>` **平级、不在其下** |
> | **发布目录**（**只能从这里发**） | `<发布目录>` | 应用 ID 绑定在这个目录上 |
> | **线上域名** | `<线上域名>` | 更新页 + 中转站的公网地址 |
> | **appId** | `<appId>` | 藏在发布目录的 `.wbapp_<appId>.genie` / `.workbuddy/applications.yaml` |
>
> 📌 **本机真实值集中写在仓库根目录的 `LOCAL.md`**（`.gitignore` 已排除，不上传 GitHub）。
> 拿到那份文件后，把下面的占位符按它填一遍即可，其余命令可以原样复制。
>
> 下文用 `1.1.0-dev.53` 举例，**整体替换成你的新版本号**。一个版本号必须贯穿全程。

---

## ⚠️⚠️ 动手前先确认（不可跳过）

**发版会产生对外影响：一发布，所有学生的客户端「检查更新」立刻能拉到新版本。**
项目约定：发版 / 推上线这类对外动作，动手前必须先经负责人明确确认。

在「第 6 步 发布上线」之前，把下面几项发给负责人，**拿到明确回复「可以发」**才继续。
**没有得到回复，不许执行第 6 步及之后的任何命令。** 第 1～5 步全是本地操作，可以先做完。

请确认：

1. 新版本号 `1.1.0-dev.53`；
2. 更新日志（CHANGELOG）内容；
3. 本次是否同时提供 Windows / Linux / macOS 安装包；
4. 是否保留上一版安装包在下载页；
5. 发布前线上 `/health` 的 `uploads` / `feedback` 数量截图（发布后要比对，少了就是发成新应用了）。

---

## 第 1 步：改代码与更新日志

在 `<工程目录>\make-page.py` 里做两件事：

**① 顶部 `CHANGELOG = [` 往列表最前面插新条目**（最新在最上）：

```python
CHANGELOG = [
    ("这一版修了什么（标题）",
     "第一行说明。\n\n"
     "**重点**可以加粗，`代码` 用反引号。\n\n"
     "第二段：写清楚学生能感受到的变化。",
     True, "new-feature.png"),   # 第 4 项配图可省略；图片放 <工程目录>\shots\ 下
    # ↓↓↓ 下面原有条目保持不动 ↓↓↓
    ("安装向导整个重做了一遍：白底、Apple 风格、全程连贯", ...),
]
```

元组是 `(标题, 描述, 是否标 NEW[, 配图文件名])`，3 元组或 4 元组。
描述支持 `\n\n` 分段、`**加粗**`、`` `代码` ``（生成 `version.json` 时会去掉 `**`）。
配图**只在网页显示**，客户端的 `notes` 不认图。

**② 找到 `PREV_VERSION = ...`，改成当前线上那一版**（本次发版前是 `1.1.0-dev.52`）。

> ⚠️ 这一行默认是硬编码的 `"1.1.0-beta.51"`，而且 **`release.py` 不会替你改**：
> 它调 `make-page.py` 时只传 `VERSION` 和 `SITE` 两个位置参数，不透传 `--prev`；
> `make-page.py` 的 `_arg()` 也只认 `--prev=xxx` 等号形式。
> **不改 → 页面并排的还是 beta.51，找不到时静默隐藏旧版入口，不报错、不中止。**
>
> 也可以事后单独重出页面：
> `python make-page.py 1.1.0-dev.53 site3 --prev=1.1.0-dev.52`

---

## 第 2 步：一键出包并生成页面

```cmd
cd /d "<工程目录>"
python release.py 1.1.0-dev.53
```

- 约 16 分钟（经验值），依次：编译三平台客户端（`linux-x64` / `osx-arm64` / `osx-x64`，
  共用 `obj` 不能并行）→ 打 macOS `.app` → 打 Linux `.deb` → 出 Windows 安装包 → 生成内测页。
- **它不会自动上线**，跑完只打印下一步提示。
- 只想重出页面（不重新编译，要求该版本 exe 已在 `dist\`）：
  `python release.py 1.1.0-dev.53 --only-page`
- 只想重出 Windows 安装包 + 页面：`python release.py 1.1.0-dev.53 --only-win`
- ⚠️ **`--only-linux` 无效**：它在 `release.py:100-101` 只改进度分母，**没有跳过任何步骤**，
  实际仍跑完整 5 步，进度会打印成 `[5/4]`。不要用。
- `release.py` 另支持 `--version=`、`--site=site4`（`--flag` / `--flag=value` 都行）。
- 可选本机验证：`python verify-install.py 1.1.0-dev.53`。
  ⚠️ **它有真实本机副作用**：会静默安装到 `%LOCALAPPDATA%\Programs\SanhaiOJ`、
  写 HKCU 注册表、建快捷方式、启动一次并截图、再静默卸载复查残留。别当无副作用的检查随便跑。

### 发版前的产物检查（**建议固化进流程**，这几项都是静默失败点）

1. **确认 `SkiaSharp` 与 `SkiaSharp.NativeAssets.Linux` 版本一致**。
   `1.1.0-dev.52` 就是只升了托管包到 `4.154.0`、原生库仍是 `2.88.9`，导致 Linux 版运行即崩。
   详见 [TROUBLESHOOTING-LINUX52.md](TROUBLESHOOTING-LINUX52.md)。
   核对命令（PowerShell）。⚠️ 两个路径坑：
   ① **`OjClientLinux` 与 `OJSetup` 是平级目录**（在 `DOCS` 下并列），
   `<工程目录>` 里**没有** `OjClientLinux\` 子目录 —— 必须用 `<客户端源码目录>`；
   ② **`publish\linux-x64\` 下没有独立 `deps.json` / `runtimeconfig.json` / `.so` / `.dll`**：
   除构建残留的 `Assets/` 目录外只有 93MB 单文件 `OjClientLinux`
   （而 `csproj:56-60` 注明单文件里其实**没有** Assets）。必须指向 `bin\Release\net8.0\linux-x64\`：
   ```powershell
   $p = "<客户端源码目录>\bin\Release\net8.0\linux-x64\OjClientLinux.deps.json"
   $d = Get-Content $p -Raw | ConvertFrom-Json
   # ① 列出所有 SkiaSharp 包（一眼看出主包与各平台原生资产的版本）
   $d.libraries.PSObject.Properties.Name | Select-String 'SkiaSharp'
   # ② 读具体依赖版本：targets 有两个键，Avalonia.Skia 只在带 /linux-x64 的那个里
   $d.targets['.NETCoreApp,Version=v8.0/linux-x64']['Avalonia.Skia/11.3.22'].dependencies
   ```
   **判据是「`SkiaSharp` 主包版本 == `SkiaSharp.NativeAssets.Linux` 版本」，不是「必须全是
   2.88.9」** —— 两条**候选路线**（截至 2026-11-14 尚未定案，源码已恢复原状）：
   - 退回路线：主包 `2.88.9` + Linux 原生 `2.88.9`，但**必须同时改
     `Controls/LiquidGlassPanel.cs`**（它用了 SkiaSharp 4.x 才有的 `SKRuntimeEffect` API），
     否则编译直接失败；
   - 升级路线：主包与 Linux 原生都 `4.154.0`（NuGet 官方确有
     `SkiaSharp.NativeAssets.Linux/4.154.0`），但 Avalonia.Skia/11.3.22 是针对 2.88.9
     编译的二进制，运行时兼容需 Linux 真机验证。
   详见 [TROUBLESHOOTING-Linux52.md](TROUBLESHOOTING-LINUX52.md) 第 6.2 节。
   **下面这组版本号只是「退回路线隔离实验」的实测值，不是当前工程状态**：
   `SkiaSharp/2.88.9`、`SkiaSharp.NativeAssets.Linux/2.88.9`、
   `SkiaSharp.NativeAssets.Win32/2.88.6`、`SkiaSharp.NativeAssets.macOS/2.88.6`、
   `SkiaSharp.NativeAssets.Linux.NoDependencies/2.88.9`（Win32/macOS 的 2.88.6 是
   NuGet 上 2.88.9 主包对应的历史惯例版本，**不是错配**；Linux 才是必须严格对齐的那个）。
   ⚠️ `libraries['Avalonia.Skia/11.3.22'].dependencies` 是**空 `{}`**，读不到错配；
   错配写在 `targets[".NETCoreApp,Version=v8.0/linux-x64"]` 那一段
   （dev.52 实测值：`SkiaSharp 4.154.0` / `SkiaSharp.NativeAssets.Linux 2.88.9`）。
2. **在干净的 Linux 虚拟机里真启动一次新包**，不是只看文件存在。
   `.deb` 装完跑 `sanhaioj-client`；免安装单文件先 `chmod +x` 再跑。
   图形环境要有 `DISPLAY`（本版本客户端走 X11）。
3. **免安装单文件 `SanhaiOJ-linux-x64` 要带可执行位**，或在下载页写明 `chmod +x`。
   `.deb` 内的 `/usr/bin/sanhaioj-client` 是 0755，但页面上的免安装单文件可能是 0644。
4. **核对产物里的 `AssemblyInformationalVersion` 与 `version.json` 的版本号一致**。
   ⚠️ 这是**预防性核对项，不是既成故障**：实测 dev.52 的 `-p:Version=` 覆盖**完全生效**，
   `OjClientLinux.dll` 与 93MB 单文件里 `beta.34` 出现 0 次、只有 `1.1.0-dev.52` 与 `1.1.0.0`。
   `csproj` 里 `1.1.0-beta.34` 只是本地 build 的默认值，发版时被覆盖。
   WinUI 那条线 `build-dist.py:124-148` 仍专门补 `-p:InformationalVersion`（历史坑：
   MSBuild 可能复用 `obj` 里旧的 `AssemblyInfo.cs`）；Avalonia 这条线历史上没补，
   建议补上作为结构性保险，但**不要写成「当前版本自报旧号」**。

**检查点**（缺一不可）：

```
<工程目录>\dist\SanhaiOJ-Setup-1.1.0-dev.53.exe
<工程目录>\dist\sha256.txt
<工程目录>\site3\index.html
<工程目录>\site3\version.json
<工程目录>\site3\download\   （6 个文件）
<工程目录>\site3\shots\
```

打开 `version.json`，确认 `"version"` 是 `1.1.0-dev.53`。

---

## 第 3 步：备份发布目录当前线上版本（**回滚用，必做**）

```cmd
set BAK=<发布目录>\_backup-1.1.0-dev.52
mkdir "%BAK%"
copy /Y "<发布目录>\site3\index.html" "%BAK%\"
copy /Y "<发布目录>\site3\version.json" "%BAK%\"
robocopy "<发布目录>\site3\download" "%BAK%\download" /E
robocopy "<发布目录>\site3\shots" "%BAK%\shots" /E
```

> `robocopy` 退出码 **0～7 都算成功**（1 = 复制了文件），`>= 8` 才是失败。
> **别用 `&&` 把这些命令串起来**，否则会把成功误判成失败而跳过后续。

---

## 第 4 步：同步到发布目录 —— **只覆盖这 4 项**

> ⚠️⚠️ **必须从 `<发布目录>\site3` 发布。**
> 应用是按**发布目录路径**认的：该目录里隐藏的 `.wbapp_<appId>.genie` 绑定了
> `appId: <appId>` / `localDir: <发布目录>\site3`；`.workbuddy/applications.yaml` 里也有同样的 locator。
> 从 `<工程目录>\site3` 发布会**另建一个应用**，老域名不变，
> 客户端写死老域名 → 全员「已是最新」= **等于没发，且不报任何错**。
>
> ⚠️⚠️ **绝对不要整目录复制 / 对整个 `site3` 用 `/MIR`。**
> 两个目录已经严重分叉：
>
> | 仅发布目录有 | 仅工程目录有 | 同名但内容不同 |
> |---|---|---|
> | `_old_engine.js`、`release-3d.html`、`.wbapp_<appId>.genie`、`.workbuddy\`、`uploads\`（线上聊天文件）、`particles2d.js.bak` | `relay.js`、`relay-agent\`、`relay-test.cjs`、`_new_engine.js`、`HEARTBEAT-RELAY-DESIGN.md` | `particles3d.js`、`server.js` |
>
> 整目录覆盖会换掉页面 3D 特效、覆盖服务端代码，还会**删掉隐藏的 appId 绑定文件**
> 和线上聊天/反馈数据。

```cmd
robocopy "<工程目录>\site3" "<发布目录>\site3" index.html version.json
robocopy "<工程目录>\site3\download" "<发布目录>\site3\download" /MIR
robocopy "<工程目录>\site3\shots" "<发布目录>\site3\shots" /MIR
```

`/MIR` **只用于 `download\` 和 `shots\` 两个子目录**（清掉上一版残留的大安装包）。

> ⚠️ **心跳中转还没上线**：发布目录里的 `server.js` 目前**没有**
> `require('./relay')`，也没有 `/relay/poll`、`/relay/agent/poll` 路由
> （全量路由里 `grep "/relay/"` 0 命中；文件里的 "relay" 全是历史命名：
> `RELAY_PUBLIC_BASE` 拼上传直链、`relay-auth.js` 旧签名、`service:'sanhaioj-relay'` 文字）。
> 工程目录的 `site3` 里已经有接入代码，但**还没同步/发布过**。
> 要让线上支持中转，必须另外做一次服务端代码同步 + 配 `RELAY_AGENT_KEY` + 重启站点，
> 这属于对外动作，见 [HEARTBEAT-RELAY-DESIGN.md](HEARTBEAT-RELAY-DESIGN.md) 的「未完成事项」。
> 两份 `relay.js` / `relay-agent/agent.js` 与独立开源仓库逐字节相同；
> 但 `relay-test.cjs` 和旧设计文档已漂移，**以独立开源仓库为准**。

**检查点**：

- `<发布目录>\site3\.wbapp_<appId>.genie` 仍然存在；
- 该目录下 `index.html` / `version.json` 的修改时间是刚才；
- `particles3d.js` 没有被换掉。

---

## 第 5 步：★ 停下来，先确认 ★

回到本文开头「动手前先确认」。**没有拿到负责人明确的「可以发」，到此为止，
不许执行第 6 步。**

---

## 第 6 步：发布上线（**对外动作**）

在 WorkBuddy 里对目录 **`<发布目录>\site3`**
执行「发布为应用 / 更新已发布应用」，命中已有应用（`appId: <appId>`）。
**不要选 `<工程目录>\site3`。**

> 源码里**没有命令行发布工具**：`release.py` 跑完只打印
> 「下一步：把站点目录发布上线」，不会自动上线。这一步必须手动完成。
> 站点是 Node 服务（`package.json` 的 `start: node server.js`），
> 不是静态站点 —— 发布时务必按「Node 应用」而不是纯静态页发布。

---

## 第 7 步：发布后抽查（**必做**）

```cmd
curl -i https://<线上域名>/version.json
curl -I https://<线上域名>/download/SanhaiOJ-Setup-1.1.0-dev.53.exe
curl -s https://<线上域名>/health
```

| 检查 | 预期 | 不通过说明 |
|---|---|---|
| 第一条 | 首字节是 `{`，`Content-Type: application/json` | 返回 HTML（`<` 开头）/「链接不完整」→ `version.json` 没同步全，或从错目录发布、或发成了静态站点 |
| 第二条 | `200` | 404 → `download\` 没同步全，或包被 `placed` 归档进 `_stale\` |
| 第三条 | `uploads` / `feedback` 数量**不比发布前少** | 变少 = 沙箱没复用 = 发成新应用，聊天文件和反馈丢了 |
| macOS 直链 | `SanhaiOJ-macos-arm64.zip` 也是 200 | 名字里含 `.app` 的路径会被网关 **403**，必须叫 `.zip` |

> 线上 `server.js` 的路由白名单包含 `/version.json`、`/download/`、`/shots/`、`/health`。
> 找不到 `/version.json` 时若平台层有 SPA fallback，就会回退成 `index.html` → **返回 HTML**；
> 客户端 `JsonDocument.Parse(HTML)` 抛异常被 `catch` 吞掉 → 学生端「检查更新」静默无反应。
>
> ⚠️ 注意区分：`version.json` 返回 HTML 是**发布 / 托管层问题**（漏同步、发成静态站点、
> 发成新应用），**不是 `make-page.py` 生成坏了** —— 脚本生成的本地文件是完好 JSON。

---

## 第 8 步（可选）：源码推 GitHub

**这是推源码，不是站点发布**，两者别混。在 `<仓库目录>` 执行：

```bash
git add -A && git commit -m "docs: 完整操作手册"
git -c http.version=HTTP/1.1 push -u origin main
```

> 本维护者机器有专用推送脚本与额外参数（真实命令见 `LOCAL.md`，不写进公开仓库）。
> 通用要点：大包用 `http.version=HTTP/1.1` 避开 HTTP/2 的 `malloc failed (2.3GB)`；
> Windows 上若遇证书吊销检查失败或凭据助手卡死，需自行配置 Git 的
> `credential.helper` / `sslVerify` / `sslBackend` 与凭据应答方式。
> **公开仓库请自行配置凭据，不要把 PAT / 密钥 / 本机路径写进 README。**

---

## 回滚

### A. 站点 / 更新页回滚

用第 3 步的备份恢复 4 项，再**从发布目录重新发布**：

```cmd
set BAK=<发布目录>\_backup-1.1.0-dev.52
copy /Y "%BAK%\index.html" "<发布目录>\site3\"
copy /Y "%BAK%\version.json" "<发布目录>\site3\"
robocopy "%BAK%\download" "<发布目录>\site3\download" /MIR
robocopy "%BAK%\shots" "<发布目录>\site3\shots" /MIR
:: 然后从 <发布目录>\site3 重新「发布 / 更新应用」
```

- **若只是漏传 `version.json` 或某个安装包，不用整体回滚**：
  把漏的文件从 `<工程目录>\site3` 补同步到发布目录（第 4 步），重新发布即可。
- ⚠️ **不要只把 `version.json` 里的数字改小来「回滚」**：
  客户端比较的是 `version.json` 的 `version` 与自身 DLL 的
  `AssemblyInformationalVersion`。已装新版本的学生本地版本更高，不会降回去，
  需另发一个更大的版本号纠正。优先用「备份覆盖 + 重新发布」。
- 历次归档的安装包在 `<发布目录>\_stale\` 和 `<工程目录>\dist\`，必要时可取回。
- ⚠️ `<发布目录>\_predeploy-backup\` 里只有 `feedback.json`，**不是站点备份，别依赖**。

### B. Linux 用户侧回退（`1.1.0-dev.52` 崩溃这类情况）

站点回滚**不能**帮已经装了新包的用户降级，必须给用户一条本地回退命令：

```bash
sudo apt remove sanhaioj-client
sudo apt install ./sanhaioj-client_1.1.0-beta.51_amd64.deb
```

只有免安装单文件时，换成上一版的 `SanhaiOJ-linux-x64` 并 `chmod +x`。
同时建议让用户回传 `/tmp/ojclient.log` 与终端 stderr 全文，
排查步骤见 [TROUBLESHOOTING-LINUX52.md](TROUBLESHOOTING-LINUX52.md)。

---

## `version.json` 字段说明

由 `make-page.py:1151-1169` 生成，与 `index.html` 同目录、同一次生成、同一份 CHANGELOG：

```json
{
  "version": "1.1.0-dev.52",
  "date": "2026-11-02",
  "page": "https://<线上域名>/",
  "notes": [{ "title": "…", "desc": "…", "new": true }],
  "downloads": {
    "windows":    { "name": "SanhaiOJ-Setup-<版本>.exe", "size": "140 MB", "sha256": "…" },
    "linux":      { "name": "SanhaiOJ-linux-x64", "size": "…", "sha256": "…" },
    "linuxDeb":   { "name": "sanhaioj-client_<版本>_amd64.deb", "size": "…", "sha256": "…" },
    "macosArm64": { "name": "SanhaiOJ-macos-arm64.zip", "…": "…" },
    "macosX64":   { "name": "SanhaiOJ-macos-x64.zip", "…": "…" }
  }
}
```

`linuxDeb` **客户端不认**，只给人下载；**Linux 客户端自动更新读 `linux` 键**（免安装单文件）。
`notes[].desc` 已经过 `plain()` 去掉 `**`，且不含配图。

客户端 `OJClient/Services/UpdateChecker.cs` 与 `OjClientLinux/Services/UpdateChecker.cs`
代码完全相同（只差 namespace）：`ManifestUrl` 硬编码老域名 → `GetStringAsync` →
`JsonDocument.Parse` → 任何异常被 `catch` 吞掉返回 `null`（启动静默检查直接吞，手动点才弹错）
→ `HasNew = Compare(Latest, Current) > 0` → 下载 URL = `SiteRoot + "/download/" + EscapeDataString(name)`。

---

## 常见坑速查

| 现象 | 最可能原因 |
|---|---|
| 发布后所有人「已是最新」 | 从 `<工程目录>\site3` 发了（另建应用）；或 `version.json` 没同步 |
| `/version.json` 返回 HTML /「链接不完整」 | 只同步了 `index.html`，漏了 `version.json`；或发布成了静态站点 / 新应用（**发布层问题，不是生成脚本坏了**） |
| 下载链接 404 | `download\` 没同步全，或包被 `placed` 归档进 `_stale\` |
| 更新完仍提示有更新（无限循环） | 版本号没写进 DLL（WinUI 线 `build-dist.py:124-148` 的 `InformationalVersion` 坑）；须协调 release.py 参数 / version.json / `@@VERSION@@` / exe 文件名 / DLL / PREV_VERSION |
| 页面旧版入口消失 | `PREV_VERSION` 没改，或上一版包没 `add` 进 `placed` 被归档 |
| 页面特效坏了 | 整目录覆盖，把 `particles3d.js` 换成了工程目录的旧版 |
| 聊天文件 / 反馈没了 | 整目录 `/MIR` 删了 `uploads\`、`.wbapp_<appId>.genie`、`.workbuddy\`，或发成新应用 |
| 心跳中转连不上（404 / `agentOnline:false`） | 发布目录的 `server.js` **还没集成** `require('./relay')` 与两条长轮询路由；线上未部署 |
| Linux 版运行即崩 | 托管 `SkiaSharp` 与原生 `libSkiaSharp.so` 版本错配（dev.52），见排障文档 |
| `git push` 卡死 / 证书错 | 本机 Git 凭据助手 / 证书检查配置问题，见 `LOCAL.md` |
| macOS 包 403 | 文件名含 `.app`，必须叫 `.zip` |

> `make-page.py:1029-1036` 会把 `download/` 里不在 `placed` 集合的文件
> 用 `os.replace` 挪进 `OJSetup/_stale/`（不真删）；`placed` 里应有：新 win exe、
> prev exe、linux 单文件、deb、两个 mac zip。prev 逻辑（`:958-977`）**必须先跑且 add 进 placed**，
> 否则上一版包被当「不属于本次发布」挪走，只打印一句 `! 找不到上一版安装包…`，**不报错、不中止**。
>
> `make-page.py:943-949` 特意比 `mtime_ns` 而不是只比 size ——
> `beta.7 → beta.8` 这种等长替换字节数一样，只比 size 会把旧包当没变。
>
> `make-page.py` **没有** `release.py` 那套 `_OPT` 解析器（脚本 `:65` 有注释明说「别去抄」）。
