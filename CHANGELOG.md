# Changelog

## 1.0.0

首个版本。CDP 驱动本机真 Edge，替代缺失的 DSH Electron webview 载体。

**功能**

- 真浏览器载体：CDP 驱动本机 Edge，逐字复用 dsh-webin 原生 DOM 脚本
- 隐藏窗口：移到屏幕外（非 headless，指纹零变化）+ 关掉后台节流
- 登录态持久化：一平台一 profile 目录，跨重启存活
- 按需启动 / 空闲自动关（默认 120 秒）
- 多平台串行支持（deepseek / qwen / 自定义）
- 自动清理网页版废对话（只删本轮新建的，绝不碰历史与置顶）
- 未登录时自动把窗口叫到前台，方便登录
- /status 暴露驱动器状态，便于排查

**实测**

- 端到端：起 Edge → 填字 → 等 2~4 秒 → 点击发送 → hook 抓到回复 → 交结果，约 5~26 秒
- 内存：干活时 596~617 MB，不干活时 0

## 2026-10-15 · 压缩 .txt 出口（compactionFileMode）

- \/compact\ 摘要不再被 webin 一律拒绝：新增 \compactionFileMode\ 配置（never/auto/always，默认 auto）。
- auto：序列化后 ≤ \compactionFileThresholdChars\（默认 10 万字符）直接发输入框；超过则全文落盘
  \~/.dsh/webin/compaction/compaction-<ts>.txt\，job 带 \ile\，走附件上传通道。
- edge-driver（web 档案主路径）：runJob 新增 4.5 步 —— CDP \DOM.setFileInputFiles\ 塞文件 + 轮询等解析完成（120s）再发短指令。
- webview 路径（client.js）：同语义的 \<webview>.debugger\ CDP 上传分支。
- 设置页新增「压缩 .txt 出口」分组：出口模式下拉 + 阈值输入，改完保存即生效。
- 配套（DSH 侧，另一个仓库）：compaction-basic 摘要目标改为 \liveSelection ?? agentTarget ?? latest\（右下角选中即生效，不用先发消息），maxTokens 4096→131072。
