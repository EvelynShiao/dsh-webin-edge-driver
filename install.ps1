<#
.SYNOPSIS
  给 dsh-webin 打上「真 Edge 驱动器」补丁。

.DESCRIPTION
  做四件事：
    1. 备份整个插件目录
    2. 放入 edge-driver.js / edge-driver-scripts.js
    3. 给 lib\index.js 插入 4 处改动（幂等 —— 已打过就跳过）
    4. 往 config.json 加 edgeDriver 配置块（已存在则不动）

.NOTES
  幂等：重复运行不会重复插入。所有插入都先检查标记字符串。
  只动本机已安装的插件文件，不联网、不拉源码。
#>
[CmdletBinding()]
param(
    # 插件目录；默认按 DSH 的 web 档案推导
    [string]$PluginDir = "$env:LOCALAPPDATA\DeepSeekHarness\.dsh\profiles\web\node_modules\dsh-webin",
    # DSH 数据目录
    [string]$DshHome = "$env:LOCALAPPDATA\DeepSeekHarness\.dsh",
    # 打完补丁后是否重启 DSH（会关掉当前界面）
    [switch]$RestartDsh
)

$ErrorActionPreference = 'Stop'
$script:Changed = 0

function Info($m) { Write-Host "  $m" }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X]  $m" -ForegroundColor Red; exit 1 }

Write-Host "`n=== dsh-webin 真 Edge 驱动器 · 安装 ===`n" -ForegroundColor Cyan

# ── 0. 检查环境 ──────────────────────────────────────────────
Info "插件目录: $PluginDir"
if (-not (Test-Path $PluginDir)) { Die "找不到插件目录。dsh-webin 装了吗？" }

$libDir    = Join-Path $PluginDir 'lib'
$indexJs   = Join-Path $libDir 'index.js'
$cfgPath   = Join-Path $DshHome 'webin\config.json'
if (-not (Test-Path $indexJs)) { Die "找不到 $indexJs" }
Ok "环境检查通过"

# 版本提示（脚本是与 0.2.23 对齐的）
$pkg = Join-Path $PluginDir 'package.json'
if (Test-Path $pkg) {
    $ver = (Get-Content $pkg -Raw | ConvertFrom-Json).version
    Info "当前 dsh-webin 版本: $ver"
    if ($ver -ne '0.2.23') {
        Warn "脚本是按 0.2.23 提取的。版本不同的话，装完请跑 patch\extract-scripts.mjs 重新提取。"
        Warn "继续（3 秒）…"; Start-Sleep -Seconds 3
    }
}

# ── 1. 备份 ─────────────────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = "$PluginDir.bak-$stamp"
Info "备份到 $bak"
Copy-Item $PluginDir $bak -Recurse -Force
$n = (Get-ChildItem $bak -Recurse -File | Measure-Object).Count
Ok "备份完成（$n 个文件）"

# ── 2. 放文件（整文件覆盖 —— 补丁版 lib 已含全部改动，天然幂等） ──
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# ⚠️ login-cookie-probe.js 是 2026-10-16 新增的模块（读 Edge profile cookie
#    判登录态，破「未登录快照 ⇒ 任务不入队 ⇒ 快照写不出」死锁）。
#    index.js 会 import 它 —— 漏装会让插件**加载即崩**，所以必须在清单里。
foreach ($f in @('edge-driver.js','edge-driver-scripts.js','index.js','client.js','login-cookie-probe.js')) {
    $src = Join-Path $here "patch\$f"
    if (-not (Test-Path $src)) { Die "缺少 patch\$f" }
    Copy-Item $src (Join-Path $libDir $f) -Force
    Ok "放入 lib\$f"
}

# ── 4. config.json ──────────────────────────────────────────
if (Test-Path $cfgPath) {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if ($null -eq $cfg.edgeDriver) {
        Copy-Item $cfgPath "$cfgPath.bak-$stamp" -Force
        $cfg | Add-Member -NotePropertyName edgeDriver -NotePropertyValue ([PSCustomObject]@{
            enabled = $true; port = 9411; executable = ''; userDataDir = ''
            hideWindow = $true; autoDeleteSessions = $true; sessionDeleteSettleMs = 4000
            idleShutdownMs = 120000; launchTimeoutMs = 30000; pollIntervalMs = 1500
            replyTimeoutMs = 600000; sendDelayMinMs = 2000; sendDelayMaxMs = 4000; verboseLog = $false
        })
        $cfg | ConvertTo-Json -Depth 10 | Set-Content $cfgPath -Encoding UTF8
        Ok "config.json 已加 edgeDriver 块"
    } else {
        Ok "config.json 已有 edgeDriver，未改动"
    }
} else {
    Warn "没有 config.json（首次使用时会自动生成默认值）"
}

Write-Host "`n=== 装完了 ===" -ForegroundColor Green
Write-Host "  下一步：重启 DSH 让新代码生效。" -ForegroundColor Yellow
Write-Host "  回退：删掉插件目录，把 $bak 改回原名。`n" -ForegroundColor DarkGray

if ($RestartDsh) {
    Info "重启 DSH…"
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'bin\.js.*web' } |
        ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }
    Start-Sleep -Seconds 4
    $ps = "$env:LOCALAPPDATA\Programs\DeepSeekHarness\tools\start-dsh.ps1"
    if (Test-Path $ps) { Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$ps`"" -WindowStyle Hidden }
    Ok "已重启（或手动开一下 start-dsh）"
}
