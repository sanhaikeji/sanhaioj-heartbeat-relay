# `1.1.0-dev.52` Linux 版启动崩溃 —— 排查与修复

> 本文是给「照着敲命令」的人看的。先按 **第 2 节** 抓日志，再按 **第 3 节** 对号入座，
> **第 5 节** 是立即可用的回退，**第 6 节** 是给维护者的根因与修复。
>
> 已确认：**与心跳中转改动无关**。52 的产物是 2026-11-02 打的，
> 客户端心跳改动是 2026-11-08，且 52 的 `deps.json` 里没有新增任何包。

---

## 1. 症状与结论

**症状**：双击图标 / 终端执行 `sanhaioj-client` 后进程立刻退出，没有窗口，有时连报错都看不到。
dev.52（2026-11-02 发）特有，beta.51 及更早版本正常。

**最可能根因（证据见第 6 节）**：

> dev.52 把托管包 `SkiaSharp` 从 `2.88.9` 升到 **`4.154.0`**，
> 但随包内嵌的原生 `libSkiaSharp.so` 仍是 **`2.88.9`**（soname `libSkiaSharp.so.88.1.0`）。
> 托管与原生版本错配 → 缺导出符号 → Avalonia 启动第一阶段建 Skia 渲染面时崩溃。
> 这是 dev.52 相比 beta.51 **唯一的依赖变更**。

排第二的是 `.deb` 的 `Depends` 没写全（ICU / OpenSSL / Xfixes / GL 未声明），
它能在 `Main` 之前让 .NET 运行时 fail-fast，且日志一行都不写 —— 用来解释「只有部分人、某个时间点开始崩」。

> ⚠️ **日志判据（很重要）**：唯一日志是 `/tmp/ojclient.log`，
> 而程序每次启动会 `File.WriteAllText` **清空重写**，且这次写入发生在 `InitializeComponent()` **之后**。
> 所以：
> - 崩在窗口创建之前 → 日志里是**上一次成功启动的旧内容**，看 banner 时间戳就能识破；
> - 崩在窗口创建之后 → banner 在、后面停住，或有 `!! 未处理异常:` 行。
>
> 第一行长这样：`===== 2026-11-02 17:30:12 MainWindow 启动（Avalonia / Linux 版） =====`。

---

## 2. 第一步：从终端抓隐藏报错（最关键）

图形界面双击看不到任何错误输出，**一定要从终端跑**：

```bash
/usr/bin/sanhaioj-client 2>&1 | tee ~/sanhaioj-run.log; echo "exit=$?"
```

裸可执行文件版（网站下载的 `SanhaiOJ-linux-x64` **默认没有可执行位**，先加）：

```bash
chmod +x ~/Downloads/SanhaiOJ-linux-x64
~/Downloads/SanhaiOJ-linux-x64 2>&1 | tee ~/sanhaioj-run.log; echo "exit=$?"
```

同时把日志尾巴也留下：

```bash
ls -l /tmp/ojclient.log; tail -n 60 /tmp/ojclient.log
```

---

## 3. 对号入座

| `~/sanhaioj-run.log` 里的报错 | 含义 | 处理 |
|---|---|---|
| `EntryPointNotFoundException` / `DllNotFoundException` 带 `libSkiaSharp` 或 `SkiaSharp` | 第 6 节的已知版本错配 | **直接跳到第 5 节回退 beta.51**，等修复版 |
| `Couldn't find a valid ICU package installed on the system` | 系统缺 ICU（本程序 `InvariantGlobalization=false`） | 第 4.2 节 |
| `No usable version of libssl was found` | 系统缺 OpenSSL 3 | 第 4.2 节 |
| `Unable to open display` / `XOpenDisplay` 失败 | 没有 X11 显示（纯 Wayland 未开 XWayland / SSH 未转发 X） | 第 4.1 节 |
| `Failed to extract` / `Permission denied` | 单文件自解压目录不可写，或文件没加可执行位 | 第 4.3 节 |
| 无任何输出、`exit=` 非 0，且日志没有**本次**时间戳 | 崩在窗口创建之前（运行时 / 平台 / XAML 层） | 依次跑 4.1 / 4.2 / 4.3，并把日志文件发给维护者 |

快速过滤关键字：

```bash
grep -nEi 'exception|skia|libSkiaSharp|icu|openssl|libssl|display|x11|not found|unhandled' ~/sanhaioj-run.log
```

---

## 4. 环境检查

### 4.1 图形环境

```bash
echo "DISPLAY=$DISPLAY  WAYLAND_DISPLAY=$WAYLAND_DISPLAY  XDG_SESSION_TYPE=$XDG_SESSION_TYPE  XDG_CURRENT_DESKTOP=$XDG_CURRENT_DESKTOP"
loginctl show-session "$XDG_SESSION_ID" -p Type 2>/dev/null
```

- 预期（X11 会话）：`DISPLAY=:0`（或 `:1`）、`XDG_SESSION_TYPE=x11` → 正常。
- 若 `DISPLAY` 为空、或会话是 `wayland` → 本版本客户端走 X11，换 **Xorg 会话登录**，
  或在 GNOME 里启用 XWayland。临时验证：

```bash
DISPLAY=:0 XDG_SESSION_TYPE=x11 /usr/bin/sanhaioj-client
```

服务器 / 容器 / SSH 场景可用 Xvfb 验证：

```bash
Xvfb :99 -screen 0 1280x800x24 & DISPLAY=:99 /usr/bin/sanhaioj-client
```

### 4.2 系统库

`.deb` 的 `Depends` 只声明了 13 项 X11/font/glib 库，**没声明 ICU / OpenSSL / Xfixes / GL**。
最小化安装、WSL、容器，或系统大版本升级后 ICU 72→74 / OpenSSL 1.1→3 的 soname 变化，都会命中。

```bash
cat /etc/os-release; uname -a
ldconfig -p | grep -Ei 'libicu|libssl|libcrypto|libX11|libxfixes|libgtk-3|libwebkit|libwpe|libvulkan|libGL\.so|libfontconfig|libfreetype'
sudo apt install -f
```

按发行版补装（**包名要先 `apt-cache search libicu` 确认版本**，Ubuntu 22.04 是 `libicu70`、24.04 是 `libicu74`）：

```bash
sudo apt install -y libicu70 libssl3 libx11-6 libxfixes3 libgl1 \
                    libfontconfig1 libfreetype6
```

> ⚠️ **不要**照抄带 `libgtk-3-0` / `libwebkit2gtk-4.1-0` / `libwpe` 的「全家桶」补装命令：
> 客户端 Linux 端 WebView 是**恒禁用**的，这些库不参与启动。把它们当成必需依赖，
> 反而会在 GNOME / KDE 已装 GTK4 的桌面、WSL、容器上引入额外冲突与下载量。
> `.deb` 的依赖声明也要**分层**：最小修复只补
> `libicu*`（alternatives 写法）/ `libssl3` / `libxfixes3` / `libgl1` 等硬依赖；
> WebView 相关只放 `Recommends`（可选），**绝不能**当硬 `Depends`。
>
> 打包侧同理：**不要**把 `SkiaSharp.NativeAssets.Win32` / `macOS` / `Linux.NoDependencies`
> 这些包塞进 `.deb` 的 `Depends` —— 它们是 NuGet 托管包，不是系统库，
> 且单文件发布时已内嵌，写进 deb 依赖只会让 `apt` 找不到包而装不上。

只想快速验证是不是 ICU：

```bash
DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 /usr/bin/sanhaioj-client
```

> 注意：客户端 Linux 端 WebView 是**恒禁用**的（题面走原生渲染），
> 所以 GTK/WPE 缺库一般不是「启动即崩」的主触发点；但手动切到 web 引擎时会崩。

### 4.3 单文件自解压与权限

dev.52 是 self-contained single-file，运行时会把 `libSkiaSharp.so`、`libHarfBuzzSharp.so`
解压到 `~/.net/OjClientLinux/<bundle-id>/` 再 `dlopen`。目录不可写、`/tmp` 或家目录被 `noexec`、
磁盘满，都会在出窗口之前退出：

```bash
echo "HOME=$HOME TMPDIR=$TMPDIR"
df -h /tmp "$HOME"
mount | grep -E ' /tmp | /home '
ls -la ~/.net/OjClientLinux/ 2>&1 | head -20
```

预期：`HOME` 有值、磁盘有余量、挂载项里没有 `noexec`、`~/.net/OjClientLinux/` 可写。
异常时换目录再试：

```bash
TMPDIR=/var/tmp HOME=/home/你的用户名 /usr/bin/sanhaioj-client
```

### 4.4 校验下载完整性（排除坏包）

```bash
sha256sum SanhaiOJ-linux-x64 sanhaioj-client_1.1.0-dev.52_amd64.deb
```

预期（与页面 `version.json` 一致）：

```
83d4e9bdff21999b558625ec7e9ebf9227c2c174bb9282c93dbbb170ee6e3129  SanhaiOJ-linux-x64
8d7b70f8ddf00d5a14435fe7b9772282914426d1478afd5bc8ca0bc7528f0791  sanhaioj-client_1.1.0-dev.52_amd64.deb
```

不一致就是下载坏了，重新下载。

---

## 5. 立即可用的回退（推荐先做这个）

beta.51 的 SkiaSharp 主包与原生库版本一致（都是 2.88.9），可正常启动：

```bash
sudo apt remove sanhaioj-client
sudo apt install ./sanhaioj-client_1.1.0-beta.51_amd64.deb
```

`OJSetup/dist/` 里保留着 `sanhaioj-client_1.1.0-beta.51_amd64.deb`（39,698,278 字节）。

只有裸可执行文件时，也请用回退版本替换。回退后仍请把以下四样反馈给维护者，
能一次定位上面所有情况：

```bash
cat /etc/os-release
echo "DISPLAY=$DISPLAY  XDG_SESSION_TYPE=$XDG_SESSION_TYPE"
cat /tmp/ojclient.log
cat ~/sanhaioj-run.log
```

---

## 6. 给维护者：根因证据与修复

### 6.1 证据链

构建命令（`OJSetup/release.py:112-119`）：

```
dotnet publish -c Release -r linux-x64 --self-contained true \
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true \
  -p:DebugType=none -p:Version=1.1.0-dev.52 -o OjClientLinux/publish/linux-x64
```

- `SanhaiOJ-linux-x64` 是 ELF64 PIE，93,386,421 字节中约 82 MB 是附加 bundle；
  bundle manifest 显示 **206 个内嵌文件 / 236 个 dll**，确认 self-contained，
  **原生库确实打进去了**（`IncludeNativeLibrariesForSelfExtract=true` 生效），
  所以「单文件发布缺原生库」不成立 —— 库在，只是**版本不对**。
- `OjClientLinux/OjClientLinux.csproj:39`：
  `<PackageReference Include="SkiaSharp" Version="4.154.0" />`。
- dev.52 的依赖图在 **`OjClientLinux/bin/Release/net8.0/linux-x64/OjClientLinux.deps.json`**
  （⚠️ **不是** `publish/linux-x64/` —— 那个目录除构建残留的 `Assets/` 外只有 93MB 单文件，
  没有独立 `deps.json` / `.dll` / `.so`）：
  `"SkiaSharp/4.154.0"`（托管 `fileVersion 4.154.0.0`），
  但同一份里 `"SkiaSharp.NativeAssets.Linux/2.88.9"` →
  `runtimes/linux-x64/native/libSkiaSharp.so`，内嵌 so 的 soname `libSkiaSharp.so.88.1.0`。
- 错配写在 **`targets[".NETCoreApp,Version=v8.0/linux-x64"]["Avalonia.Skia/11.3.22"].dependencies`**：
  同时是 `SkiaSharp 4.154.0` 与 `SkiaSharp.NativeAssets.Linux 2.88.9`。
  ⚠️ `libraries["Avalonia.Skia/11.3.22"].dependencies` 是**空 `{}`**，读不到错配。
- ICU 需求写在 **`bin/Release/net8.0/linux-x64/OjClientLinux.runtimeconfig.json`**（497 B）：
  `"System.Globalization.Invariant": false` → 强制需要系统 ICU；同一目录的
  `deps.json` 里还列着 `libssl.so.3`、`libgtk-3.so.0` 等系统库名。
- 与 beta.51 逐项对比：内嵌 `libSkiaSharp.so` 的内容 **sha256 完全相同**
  （`eb51549cb480b5df3f4fa2100dbecfec7e5b7678`）、soname 同为 `88.1.0`；
  只有托管从 `2.88.9.0` 变成 `4.154.0.0`。**这是 52 唯一的包变化。**

### 6.1.1 为什么**只有 Linux** 崩（NuGet 解析机制）

`OjClientLinux/obj/project.assets.json` 把因果链补完整了：

- `Avalonia.Skia/11.3.22` 声明依赖 `SkiaSharp 2.88.9`、
  `SkiaSharp.NativeAssets.Linux 2.88.9`、`SkiaSharp.NativeAssets.WebAssembly 2.88.9`；
  `CSharpMath.SkiaSharp/0.5.1` 声明 `SkiaSharp 2.80.1`。
- 项目只显式引用了 `SkiaSharp >= 4.154.0`（`csproj:39`），**没有**显式引用
  `SkiaSharp.NativeAssets.Linux` → NuGet 的「直接依赖胜出」把主包提到 `4.154.0`，
  Linux 原生资产却停在 Avalonia.Skia 要求的最低 `2.88.9`。
- **`SkiaSharp/4.154.0` 自身的依赖只有 `SkiaSharp.NativeAssets.Win32 4.154.0`
  和 `SkiaSharp.NativeAssets.macOS 4.154.0`，没有 Linux 包** —— 没人把 Linux 资产提上去。

`project.assets.json` 的 `libraries` 段结果：

```
SkiaSharp/4.154.0
SkiaSharp.NativeAssets.Linux/2.88.9        ← 错配，唯一出错的平台
SkiaSharp.NativeAssets.WebAssembly/2.88.9  ← 也旧，未使用
SkiaSharp.NativeAssets.Win32/4.154.0       ← 匹配
SkiaSharp.NativeAssets.macOS/4.154.0       ← 匹配
```

→ **Windows 版与 macOS 版主包/原生资产都是 4.154.0、匹配；只有 Linux 落在
`4.154.0 + 2.88.9`**。这就解释了用户反馈为何只针对「52 Linux 版」。
另外 `SkiaSharp.NativeAssets.Linux/2.88.9` 自身还声明依赖 `SkiaSharp 2.88.9`，
与主包冲突；NuGet 因 `>=` 语义**不报错**，但运行时必炸（所以编译期完全看不出来）。

> 修复含义：本机 NuGet 缓存里 `skiasharp.nativeassets.linux` 只有 2.88.9，
> 但 **NuGet 官方确实发布 `SkiaSharp.NativeAssets.Linux/4.154.0`**
> （主包 nuspec 没自动拉它，正是错配根因）。所以两条路线都有实物可依，
> 区别只在「改功能代码」还是「改依赖 + 冒运行时兼容风险」，见 6.2。

后果：4.154.0 的托管封装 `DllImport("libSkiaSharp")` 加载 88.1.0 的旧原生库，
缺新增导出符号 → `EntryPointNotFoundException` / 原生层崩溃。
Avalonia 启动就建 Skia 渲染面，所以「运行即崩、无窗口」。

### 6.2 修复方向（**方向未定，需负责人拍板**）

> ⚠️ 2026-11-08 更新：**这里列的是两条候选路线，不是「已经这么改了」。**
> 曾按路线 A 试改过，`dotnet build` 直接编译失败（见下方 6.2.1），
> 已把三处源码**恢复原状**、改动整理成待用补丁，等选择后再应用。
> 在此之前，线上用户仍走第 5 节的「回退 beta.51」。

**共同前提：`SkiaSharp` 主包版本必须与 `SkiaSharp.NativeAssets.Linux` 版本一致。**

| | 路线 A：退回 2.88.9 | 路线 B：保持 4.154.0、补齐 Linux 原生 |
|---|---|---|
| 做法 | 主包退回 `2.88.9`（与 `Avalonia.Skia/11.3.22`、`CSharpMath.SkiaSharp/0.5.1` 对齐） | 显式引用 `SkiaSharp.NativeAssets.Linux/4.154.0`，让 native 从 2.88.9 升到 4.154.0 |
| 包是否存在 | 本机缓存就有，无需联网 | ✅ NuGet 官方有 `4.154.0`（主包 nuspec 没自动拉它，需显式引用），但要联网还原 |
| 代价 | **必须同时改 `Controls/LiquidGlassPanel.cs`**（见 6.2.1） | 无需动功能代码，但 Avalonia.Skia/11.3.22 是针对 2.88.9 编译的二进制，4.x 是否运行时兼容**未知，需 Linux 真机验证** |
| 风险 | 牺牲 / 降级液态玻璃真实折射（改用 CPU 兜底） | 可能出现 `MissingMethodException` 之类运行时错误，编译期看不出来 |

#### 6.2.1 路线 A 为什么不是「改一行」

`OjClientLinux/Controls/LiquidGlassPanel.cs` 用的是 **SkiaSharp 4.x 才有**的 API：

```csharp
SKRuntimeEffect.CreateShader(...)
SKRuntimeEffectUniforms / SKRuntimeEffectChildren / SKRuntimeEffect.Uniforms
SKShader.CreateRuntimeShader(effect, uniforms, children, ...)
```

该文件的注释明说：当初正是为了绕开 **2.88.9 原生层** 的
`SEHException` / `AccessViolationException`（`SKRuntimeEffect` 构造函数直接抛），
才把主包升到 4.x 改用 3 参数重载。`SKRuntimeEffect.Build(String)` 在 2.88.9 里返回 `void`。
另外 `Controls/Liquid/GlassCore.LensCpu` 还有自己的 `SKRuntimeEffect` 用法。

所以路线 A 需要**第四处改动**：把 SkSL / `SKRuntimeEffect` 路径用编译期开关隔离
（当前只有 `OJ_GLASS_SKSL=0` 的**运行时**开关，没有编译期隔离），
退回 2.88.9 时让液态玻璃走 CPU 逐像素兜底。这属于**产品取舍**（要不要保留真实折射），
不能由工具擅自决定，故暂停等确认。

#### 6.2.2 其余修复项（两条路线都适用）

1. `OJSetup/release.py:112-119`：Avalonia 的 publish **建议补**
   `-p:InformationalVersion=<版本>`（WinUI 那条 `build-dist.py:124-148` 已经做了），
   作为结构性保险。
   ⚠️ **这不是 52 的既成故障**：实测 `release.py` 的 `-p:Version=` 覆盖**完全生效**，
   `OjClientLinux.dll` 与 93MB 单文件里 `beta.34` 出现 **0 次**，只有 `1.1.0-dev.52`
   与 `1.1.0.0`；`csproj:20` 的 `1.1.0-beta.34` 只是本地 build 默认值，发版时被覆盖。
   该项**只影响「检查更新」，不影响启动**，别写成「当前 DLL 自报旧版本号」。
2. `OJSetup/make-deb.py:49-51` 的 `DEPENDS` **分层补齐**：硬依赖只加
   `libicu*`（用 alternatives 写法，别写死单一版本）、`libssl3`、`libxfixes3`、`libgl1`；
   WebView 相关（GTK/WPE）**只放 `Recommends`**，不能当硬 `Depends` ——
   Linux 端 WebView 恒禁用，加硬依赖会在精简系统 / GTK4 桌面上装不上。
   ⚠️ 更不要把 `SkiaSharp.NativeAssets.*` 这些 NuGet 托管包写进 `Depends`（它们不是系统库）。
3. `.desktop`（`make-deb.py:108-122`）无 `Env=`、无 wrapper →
   建议加一个启动脚本兜底 `DISPLAY` / `XDG_SESSION_TYPE`，并在启动前做一次依赖自检。
4. `site3/download/SanhaiOJ-linux-x64` 权限是 `0644`（没可执行位），
   `.deb` 内是 `0755`。发布时给免安装单文件加可执行位，或在下载页写明要 `chmod +x`。
5. 加一个启动前的 stderr 捕获（在 `UnhandledException` 钩子注册之前也能写日志），
   否则运行时 / 平台层崩溃永远是「日志空白」。

### 6.3 相关文件索引

| 用途 | 路径 |
|---|---|
| 构建 | `OJSetup/release.py:40,110-119,127-141` |
| deb 打包 | `OJSetup/make-deb.py:49-51,108-122,147-157,160-190` |
| Windows 打包（对照） | `OJSetup/build-dist.py:124-148,150-171,233-240` |
| 更新页 / version.json | `OJSetup/make-page.py:37,929,979-997,1160-1169` |
| 客户端 csproj | `OjClientLinux/OjClientLinux.csproj:13,17,20,28-43` |
| 启动路径 | `OjClientLinux/Program.cs:9-24`、`App.axaml.cs:11-27`、`MainWindow.axaml.cs:1945-2015` |
| 日志 | `OjClientLinux/Services/Log.cs:8-9,25-29` |
| 产物 | `OJSetup/dist/sanhaioj-client_1.1.0-dev.52_amd64.deb`、`site3/download/SanhaiOJ-linux-x64`、`site3/version.json` |

---

## 7. 另一个独立问题：线上 `version.json` 返回「链接不完整」

本地 `site3/version.json` 是完好 JSON（`"version":"1.1.0-dev.52"`、
`downloads.linux` 带 sha256），但线上
`https://sanhaioj-client-beta.app.workbuddy.host/version.json` 返回 HTML「链接不完整」。

含义：**自动更新链路失效**，只有手动下载 52 的人才升级，这解释了为什么是「有人反映」而不是全量崩溃。
这属于托管/发布层问题，见 [RELEASE-PLAYBOOK.md](RELEASE-PLAYBOOK.md) 的发布检查点。
