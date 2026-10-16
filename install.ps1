<#
.SYNOPSIS
  把本仓库的 lib/ 覆盖到已装的 dsh-webin 插件目录（本地开发用）。

.DESCRIPTION
  ## 这个脚本什么时候用

  正经安装请用 DSH 自己的插件机制（推荐）：

      dsh plugin add dsh-webin-edge-driver

  本脚本是**本地开发**的便捷通道：你已经装了 dsh-webin，想把手改的
  lib/ 直接盖上，不想走一遍插件安装流程时用。

  ## 为什么不再「打补丁」

  2026-10-16 起本仓库改成**完整插件包**（lib/ 是完整可运行实现 +
  package.json 的 dsh.bundle.patch），不再是从 dsh-webin 抠出来的一堆补丁。
  原因：补丁形态**没法被 DSH 当插件安装**（手机端会报
  「缺少 package.json 中的 dsh.bundle.patch」），而手机正好是主要场景之一。

  ## 做的事（三步，都可回退）

    1. 备份现有插件目录
    2. 用本仓库 lib\ 覆盖插件目录的 lib\
    3. 提示重启 DSH

.NOTES
  只动本机已安装的插件文件，不联网、不拉源码。
  覆盖是幂等的：重复运行结果一致。
#>
[CmdletBinding()]
param(
    # 插件目录；默认按 DSH 的 web 档案推导
    [string]$PluginDir = "$env:LOCALAPPDATA\DeepSeekHarness\.dsh\profiles\web\node_modules\dsh-webin",
    # 打完补丁后是否重启 DSH（会关掉当前界面）
    [switch]$RestartDsh
)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "  $m" }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

Write-Host "`n=== dsh-webin-edge-driver · 本地覆盖安装 ===`n" -ForegroundColor Cyan

# ── 0. 路径与来源自检 ────────────────────────────────────────
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcLib = Join-Path $here 'lib'
Info "源目录:   $srcLib"
Info "插件目录: $PluginDir"

if (-not (Test-Path $srcLib)) { Die "找不到 lib\ —— 仓库结构不对（应从仓库根目录运行）" }
if (-not (Test-Path $PluginDir)) { Die "找不到插件目录。dsh-webin 装了吗？" }

$dstLib = Join-Path $PluginDir 'lib'
if (-not (Test-Path $dstLib)) { Die "插件目录里没有 lib\ —— 这不像 dsh-webin 的安装" }

# 必须的文件（缺任何一个都会让插件加载即崩 —— import 解析失败，provider 全不注册）
$need = @('index.js','client.js','edge-driver.js','edge-driver-scripts.js','login-cookie-probe.js','credential-store.js','session-gc.js','slot-names.js')
foreach ($f in $need) {
    if (-not (Test-Path (Join-Path $srcLib $f))) { Die "源目录缺少 lib\$f" }
}
Ok "文件齐全（$($need.Count) 个）"

# ── 1. 备份 ──────────────────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = "$PluginDir.bak-$stamp"
Copy-Item $PluginDir $bak -Recurse -Force
$n = (Get-ChildItem $bak -Recurse -File | Measure-Object).Count
Ok "已备份到 $bak（$n 个文件）"

# ── 2. 覆盖 lib\ ─────────────────────────────────────────────
foreach ($f in $need) {
    Copy-Item (Join-Path $srcLib $f) (Join-Path $dstLib $f) -Force
    Ok "放入 lib\$f"
}

# 自定义平台模板放插件根目录（不在 lib\）
$exSrc = Join-Path $here 'provider.example.json'
if (Test-Path $exSrc) {
    Copy-Item $exSrc (Join-Path $PluginDir 'provider.example.json') -Force
    Ok "放入 provider.example.json"
}

Write-Host "`n完成。" -ForegroundColor Green
Warn "改动要生效必须重启 DSH（插件代码在内存里，热重载不一定覆盖 host 半）。"
Warn "想回退：把 $bak 覆盖回去即可。"

if ($RestartDsh) {
    Info "正在结束 DSH 进程…"
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'DeepSeekHarness.*bin\.js' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Ok "已结束。请手动重新启动 DSH。"
}
