# QC Smart Reader

![QC Smart Reader：把网页、PDF 与 YouTube 公开字幕变成可核验的证据链](store-assets/social-preview.png)

[![CI](https://github.com/vyang472/qc-smart-reader-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/vyang472/qc-smart-reader-extension/actions/workflows/ci.yml)
[![最新版本](https://img.shields.io/github/v/release/vyang472/qc-smart-reader-extension?display_name=tag)](https://github.com/vyang472/qc-smart-reader-extension/releases/latest)
[![MIT License](https://img.shields.io/badge/license-MIT-0f766e.svg)](LICENSE)
[![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-2563eb.svg)](manifest.json)

**[English](README.md) · 简体中文**

把网页、PDF 和 YouTube 公开字幕变成带原文 quote 的 claim，并沉淀进本地证据图谱。

QC Smart Reader 是一个 **macOS 优先**的 Chrome 扩展 + 本地 Python Companion。它复用你正在使用的浏览器会话采集材料，把内容保存为 SQLite 与可直接阅读的 Markdown，并要求每条已审 claim 都能回到原文中的精确引用。你可以接 Codex CLI、OpenAI-compatible / Anthropic，也可以完全不配模型。

> 模型可以总结；证据决定这句话能不能信。

## 实际界面

| 在浏览器里采集 | 对照原文审证据 | 保留可迁移的本地 Vault |
| --- | --- | --- |
| ![在 QC Smart Reader 侧边栏采集网页](store-assets/screenshots/01-capture.png) | ![用原文 quote 审阅 claim](store-assets/screenshots/02-evidence-review.png) | ![查看本地 Markdown 与 SQLite Vault](store-assets/screenshots/03-local-vault.png) |

## 它和普通 AI 阅读器有什么不同

- **先证据，后结论。** claim 只有在 `source_id + chunk_id + quote` 仍能逐字命中当前原文时，才能进入 `reviewed`。
- **来源变了，下游会自动过期。** 同一来源重新采集后，失效引用会让相关 claim 回退，并把专题包、交付物标成 stale。
- **默认本地。** Companion 只监听 loopback，用随机 Pairing Token 鉴权；Vault 在你的 Mac 上。模型是可选项，首次发送材料前必须明确同意。
- **直接复用你的 Chrome 登录态。** 批量任务由扩展执行，服务端记录每条 URL 的 lease、heartbeat、重试和恢复状态。
- **交付物可追溯。** 研究报告、PPT 大纲、视频脚本与策略任务书都能沿 claim / evidence 回到来源。
- **不用 API Key 也能试完整链路。** 本地 deterministic mock 会产出结构化、引用真实且明确标注的结果；已登录的 Codex CLI 也可以作为模型路线。

## 安装 v0.9.0

当前正式支持路径是 **macOS + Chrome 116+ + 简体中文产品界面**。

1. 从 [QC Smart Reader v0.9.0](https://github.com/vyang472/qc-smart-reader-extension/releases/tag/v0.9.0) 下载两个文件：
   - `qc-smart-reader-companion-0.9.0.zip`
   - `qc-smart-reader-extension-0.9.0.zip`
2. 解压 Companion ZIP，双击 `install.command`（也可以运行 `bash install.command`）。安装器会安装当前用户的后台服务、验证可用性，并把 Pairing Token 复制到剪贴板。
3. 解压 Extension ZIP。打开 `chrome://extensions`，开启**开发者模式**，点击**加载已解压的扩展程序**，选择包含 `manifest.json` 的目录。
4. 打开 QC Smart Reader 侧边栏，在**设置**中填入 `http://127.0.0.1:37621`，粘贴 Pairing Token，点击**测试本地服务**。

到这里就可以采集，并使用 deterministic mock 跑完整证据链。需要模型时，在**设置 → 模型设置**中选择：

- **Codex CLI：**调用本机已安装、已登录的 `codex`；QC Smart Reader 不再要求单独填写 API Key。
- **OpenAI-compatible / Anthropic：**使用你填写的 endpoint、模型和 API Key。
- **不配模型：**结构化抽取留在本机，并明确标记 deterministic mock 结果。

源码启动、升级、故障恢复与卸载说明见[《从零到能用》](上手指南.md)。

## 证据链怎么工作

```text
Chrome 采集 / PDF / 字幕
           │
           ▼
   source → chunk → 精确 quote
                         │
                         ▼
                       claim
                         │
                         ▼
              专题包 → 交付物
```

扩展只向 loopback Companion 发送带鉴权的请求。Companion 在 `~/Documents/QC Smart Reader Vault/` 下维护便于查询的 SQLite，以及可直接阅读、迁移和用 Obsidian 打开的 Markdown Vault。只有当你主动选择模型操作时，相关提示词与材料才会发给你选择的 provider，并受该 provider 的条款约束。

## v0.9.0 能力

| 工作流 | 当前行为 |
| --- | --- |
| 网页采集 | 当前页、选中文本、URL 批量队列；复用当前 Chrome 会话并支持任务恢复 |
| 站点抽取 | 常见论坛与发布平台专用 profile，以及通用网页 profile |
| PDF | 文本层按页提取；低文本页可用 macOS Vision OCR，并保留页码引用 |
| YouTube | 手贴字幕，或通过现有 `yt-dlp` 获取公开字幕；不转录音频、不读取 cookie |
| 知识审阅 | entities、claims、evidence、relations、assumptions、risks、tasks、审阅历史、merge/split 与 quote 复验 |
| 交付 | 专题包、研究报告、PPT 大纲、视频脚本、策略交接，保留证据引用 |
| 完整性 | Vault Doctor、lineage 重建、来源版本、stale 传播、确定性发布包与升级回滚 |

## 信任与隐私边界

- 当前是单用户、本地软件，没有 QC Smart Reader 托管账号和云同步。
- Companion 默认仅监听 `127.0.0.1`，所有数据 API 都需要随机 Pairing Token。
- 网页内容是不可信输入；模型结果在证据校验通过前也不可信。
- 本地 PDF 只能从允许目录导入；远程 PDF 与字幕下载会拒绝本机、内网、链路本地和保留地址。
- 项目不会绕过付费墙，不会为字幕导入浏览器 cookie，也不会转录视频音频。
- Vault 是你的研究资料。备份时要同时保存 `vault/` 和 `state/`；只有 Markdown 不能保留全部关系和审阅状态。

处理敏感材料前，请阅读完整的[隐私政策](PRIVACY.md)与[安全政策](SECURITY.md)。

## 当前限制

- 安装器、后台服务生命周期和扫描版 PDF OCR 目前以 macOS 为主；尚无 Windows / Linux 正式安装包。
- 产品界面目前只有简体中文；项目文档提供中英双语。
- Chrome Web Store 版本通过审核前，需要使用开发者模式加载扩展。
- 复杂 PDF 的双栏顺序、表格、图、公式仍可能需要人工复核。
- YouTube 自动字幕依赖已有的 `yt-dlp`；私有字幕和音频转写不在范围内。
- 批量采集由扩展充当浏览器执行器，因此运行时需要 Chrome 可用。

计划与明确不做的事情见 [ROADMAP.md](ROADMAP.md)。

## 开发与验收

```bash
git clone https://github.com/vyang472/qc-smart-reader-extension.git
cd qc-smart-reader-extension
bash scripts/test_all.sh
```

完整 gate 会检查 Python、JavaScript 与 shell 语法，运行 Companion 行为测试、启动器测试、macOS 安装 / 升级 / 回滚 / 卸载生命周期测试、站点抽取与侧边栏测试、真实 Chromium 扩展采集与重启恢复，以及临时 Vault 的端到端证据链。v0.9.0 release candidate 在 macOS 上通过了 86 个 Python 测试、91 个 Node / Chromium 测试（浏览器 0 skip）、12 个启动器测试、10 个生命周期测试和端到端 smoke。

发布包来自显式 allowlist，文件顺序、时间戳与权限固定，并生成 SHA-256：

```bash
python3 scripts/release.py --check
python3 scripts/release.py
shasum -a 256 -c dist/release/SHA256SUMS
```

## 参与项目

欢迎提交明确、可复现的 issue 与小范围 PR。请先读 [CONTRIBUTING.md](CONTRIBUTING.md)；设计和使用问题可以发到 [GitHub Discussions](https://github.com/vyang472/qc-smart-reader-extension/discussions)；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

如果 QC Smart Reader 确实让你的研究更容易核验，可以点一个 GitHub Star，帮助其他偏好本地优先的研究者发现它。更重要的是，请告诉我们：哪个来源、证据审阅或安装流程在你的真实使用中还会失败。

## 许可证

[MIT](LICENSE) © Vincent Yang 与贡献者。
