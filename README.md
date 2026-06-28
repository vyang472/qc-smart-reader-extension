# QC Smart Reader Lite

一个本地 Chrome Extension + companion service，用来复刻“读网站、读帖子、读论文片段”的核心工作流：

- 读取当前网页正文、标题、URL、标题层级和代码片段。
- 右键选中文本后发送到侧边栏。
- 批量导入 URL，复用当前 Chrome 登录态做后台采集。
- 通过本地服务导入本地 PDF 路径或网页 PDF URL，保留页码 chunk。
- 用多个 Agent 视角一起阅读：学员小白、老师、领域专家、工程师、审查者。
- 接 OpenAI-compatible 或 Anthropic API。
- 把完整来源与阅读结果保存到本地 SQLite + Markdown Vault，并导出 Markdown/JSON。

## 启动本地服务

先启动 companion service：

```bash
cd qc-smart-reader-extension
python3 companion_service/server.py
```

默认服务地址：

```text
http://127.0.0.1:37621
```

默认知识库位置：

```text
~/Documents/QC Smart Reader Vault/vault
```

本地服务会创建：

- SQLite 索引：`~/Documents/QC Smart Reader Vault/state/qc_smart_reader.sqlite3`
- Markdown Vault：`~/Documents/QC Smart Reader Vault/vault`

## 安装

1. 打开 Chrome：`chrome://extensions`
2. 打开右上角 `Developer mode`
3. 点击 `Load unpacked`
4. 选择本目录：

```text
<path-to-this-repo>
```

## 测试

运行 companion service 的离线集成测试：

```bash
cd qc-smart-reader-extension
python3 -m unittest discover -s tests -v
```

运行 Node 侧站点抽取、sidepanel VM 和 live extension smoke 测试：

```bash
cd qc-smart-reader-extension
node --test tests/test_browser_site_profiles.mjs tests/test_live_extension_capture_smoke.mjs tests/test_quantclass_extractor.mjs tests/test_site_profiles.mjs tests/test_sidepanel_strategy_tickets.mjs tests/test_sidepanel_project_dashboard.mjs tests/test_sidepanel_batch_dispatch.mjs
```

当前测试覆盖：来源入库/Vault 落盘/搜索/去重、canonical URL 归一化、同内容多 URL alias 记录、同 canonical URL 多版本历史、新版本 stale 旧 reviewed source 下游、source version diff、同步 re-extraction job 台账、provider 抽取的 invalid JSON repair、伪 quote、跨来源 chunk id、缺 evidence、source-only citation 和 max-claim 截断、job 生命周期控制、100 URL 服务端批量恢复、service restart 后恢复同一 read job、sidepanel VM 重启后从服务端恢复并完成 100 URL job、claim/evidence 审阅工作台的 quote context 渲染、claim 编辑/单条/批量审阅、claim merge/split 基础、claim history event/diff 渲染、evidence 审阅提交和当前 chunk quote 复验、live extension 批量入口从 sidepanel 经后台标签采集 QuantClass 单页和多页 fixture 并写入 companion service（断言 service-owned claim-next、heartbeat event、pause/resume/cancel job events、关闭 Chromium 后重开恢复、取消后状态保护、分页 checkpoint、续页评论楼层、附件 ledger、项目 dashboard 质量 blocker）、live extension 当前页读取 -> 结构化知识 mock 抽取 -> claims/evidence UI 渲染、live GitHub issue fixture 证明真实扩展使用 browser profile bundle 抽取 thread blocks/附件、浏览器 bundle 与 registry 在 QuantClass/BBS、知乎、微信公众号文章、Substack、Medium、Hacker News、Reddit、arXiv、GitHub Issues/Discussions、通用网页 fixture 上的关键字段 parity、PDF 文本层解析与页码 chunks，以及各站点基础 profile fixture。

## 使用

1. 点击浏览器工具栏里的 `QC Smart Reader` 图标打开侧边栏。
2. 在 `设置` 里确认：
   - `Companion URL`: `http://127.0.0.1:37621`
   - `服务商`: OpenAI-compatible 或 Anthropic
   - `Base URL`: 例如 `https://api.openai.com/v1`
   - `API Key`
   - `模型名`
3. 点 `测试本地服务`，确认本地 Vault 可写。
4. 打开网页或论坛帖子，点 `读取当前页`。
5. 在 `Agent` 里选择角色。
6. 回到 `聊天`，点 `开始阅读`。
7. 有价值的结果点 `保存笔记`，内容会优先写入本地 Vault；如果本地服务没开，会回退到 Chrome 本地 storage。
8. 到 `交付` 页签选择研究报告、PPT 大纲、视频脚本或策略任务单，点击 `生成交付物`，Markdown 会写入 Vault 的 `wiki/deliverables/`。
9. 在 `知识库` 页签点击 `抽取结构化知识`，当前来源会先入库，再生成草稿 claims、entities、evidence、risks 和 tasks。
10. 在 `知识库` 页签点击 `生成学习包`，当前来源会生成检索练习、Anki 候选、费曼复述、卡点检查和复习队列。
11. 在 `知识库` 页签的 `待审队列` 中接受或拒绝 `new/extracted` 来源；也可以在 `来源库` 中搜索关键词、按状态筛选来源，或点 `详情` 查看原始文件、摘要文件、chunks、原文预览、关联笔记和版本 diff；点 `设为当前` 可把历史来源重新载入聊天页，点 `重跑结构化抽取` 可对已入库来源重新生成结构化草稿并写入 job/event 台账。

## 批量采集

`批量` 页签支持两种入口：

- 粘贴 URL：一行一个链接，点击 `加入队列`。
- 当前窗口标签：点击 `加入当前窗口标签`，把当前窗口里所有 `http/https` 标签加入队列。

点击 `开始处理` 后，扩展会优先从 companion service 通过 `claim-next` 领取 URL lease，再逐个打开后台标签页，复用当前 Chrome 登录态读取页面，最后写入本地 Vault。每条队列项会显示 `pending/running/success/failed/canceled` 状态；失败项可以保留在队列里再次处理。扩展会同时把每个 URL 的运行状态写入 companion service 的 `job_items` / `job_events`，并发送 heartbeat，方便后续审计和恢复。服务端支持 pause/cancel 派发拦截、取消后忽略迟到 success 覆盖、过期 lease 重新领取；recover 会尊重未过期 lease 和最近 heartbeat，避免误杀仍活跃的长任务。如果服务端任务接口不可用，扩展会回退到本地队列循环。点击 `恢复服务端任务` 可以把最近的服务端 read job 拉回当前队列；失败或卡住的条目可以单独点 `重试`；长队列运行时可以暂停、取消，或清理已完成项。

## PDF 导入

`批量` 页签里的 PDF 输入框支持两种格式：

- 本机文件路径，例如 `/Users/me/Documents/paper.pdf`
- 网页 PDF URL，例如 `https://example.com/report.pdf`

导入后，本地服务会解析文本层、按页生成 chunks、复制原 PDF 到 `原始资料/papers/`，并把来源写入 SQLite + Markdown Vault。扫描版或文本很少的 PDF 会标记为低置信，后续需要 OCR 或人工复核。

## YouTube 字幕导入

`批量` 页签里的 YouTube 字幕入口支持粘贴已经获取的字幕文本，推荐格式：

```text
[00:00] 第一段字幕
[00:15] 第二段字幕
```

导入后会创建 `kind=video`、`site=youtube` 的来源，按字幕时间戳写入 chunks，并在引用中保留 `time:`。当前版本不做音频转写；无字幕视频需要先用外部方式取得字幕文本。

## 当前 V0.2 能力

- 本地 companion service：`GET /health`、`POST /v1/captures`、`GET /v1/sources`、`GET /v1/sources/:id`、`POST /v1/sources/:id/status`、`POST /v1/notes`、`GET /v1/notes`、`POST /v1/search`。
- Local auth：服务启动时生成 `state/pairing_token.txt`；除 `/health` 外的 `/v1/*` 请求都需要扩展发送 `x-qc-pairing-token`，CORS 只允许 Chrome extension 和 localhost origins。
- Model runtime：`GET/POST /v1/model-settings` 把 provider、Base URL、model、temperature 和 API Key 保存在 companion service；`POST /v1/llm/chat` 由本地服务代理 OpenAI-compatible/Anthropic 调用并写入 `agent_runs`，扩展不再直连模型 API。
- Job tracking：`POST /v1/jobs/read`、`GET /v1/jobs`、`GET /v1/jobs/:id`、`GET /v1/jobs/:id/events`、`POST /v1/jobs/:id/status`、`POST /v1/jobs/:id/recover`、`POST /v1/jobs/:id/retry-failed`、`POST /v1/jobs/:id/pause`、`POST /v1/jobs/:id/resume`、`POST /v1/jobs/:id/cancel`、`POST /v1/jobs/:id/clear-completed`、`POST /v1/jobs/:id/claim-next`、`POST /v1/jobs/:id/items/:item_id/status`、`POST /v1/jobs/:id/items/:item_id/retry`、`POST /v1/jobs/:id/items/:item_id/heartbeat`；job item 记录 `error_category`，覆盖 `auth_required`、`page_timeout`、`extraction_empty`、`parse_failed`、`duplicate`、`service_error` 等失败类型，UI 会显示分类并支持一键重试；成功采集后会写入 `item_capture`、`item_quality_gate`、`item_review_queue` 或 `item_extract` 事件，用于复盘每条 URL 是进入人工审查还是可进入抽取。
- Deliverables：`POST /v1/deliverables`、`GET /v1/deliverables`、`GET /v1/deliverables/:id`，支持研究报告、PPT 大纲、视频脚本、策略任务单 Markdown 输出；可以传 `topic_package_ids` 从已审专题包展开 claims/evidence。
- Strategy handoffs：`POST /v1/strategy-handoffs`、`GET /v1/strategy-handoffs`、`GET /v1/strategy-handoffs/:id`，从 final `strategy_task_brief` 生成策略实现交接包，落盘到 `wiki/strategies/` 并绑定 deliverable/topic/source/claim/evidence ids。
- Strategy tickets：`POST /v1/strategy-tickets`、`GET /v1/strategy-tickets`、`GET /v1/strategy-tickets/:id`、`POST /v1/strategy-tickets/:id/status`，从 handoff 生成数据接入、信号代码、组合回测、风控、回测报告和监控票据，记录 owner/status/objective/inputs/outputs/acceptance 和 claim/evidence 回链；同一 handoff 下同一 kind 的重复创建会幂等返回已有票据。
- Backtest results：`POST /v1/backtest-results`、`GET /v1/backtest-results`、`GET /v1/backtest-results/:id`，把回测 period、universe、benchmark、metrics、costs、slippage、drawdown、turnover、capacity、artifacts、failure notes 和 outcome 回连到 handoff/claims/risks，并落盘到 `wiki/strategies/backtests/`。
- Strategy reviews：`POST /v1/strategy-reviews`、`GET /v1/strategy-reviews`、`GET /v1/strategy-reviews/:id`，记录 paper-ready/live-ready 风险审查 checklist、reviewer、note、pass/fail 和 artifacts；只有 passed review 才会晋升 backtest/handoff 状态。
- Projects：`GET /v1/projects`、`POST /v1/projects`、`GET /v1/projects/:id/dashboard`、`GET/POST /v1/projects/:id/brief`、`POST /v1/projects/:id/stages/:stage/confirm`，扩展设置页可以创建/切换当前项目，维护项目 brief/rubric，并显示收集、初筛、深研、交付、策略五阶段仪表盘；captures、sources、notes、search、knowledge records、deliverables、export 会带 `project_id` 做项目隔离。
- Capture plans：`POST /v1/capture-plans`、`GET /v1/capture-plans`、`GET /v1/capture-plans/:id`、`POST /v1/capture-plans/:id/status`、`POST /v1/capture-plans/enqueue-approved`，先把 seed URL 进入候选池，记录 source type、采集理由、优先级、审批/拒绝原因，只有 approved 来源会一键创建 read job。
- Vault doctor：`GET /v1/vault/doctor?project_id=...&write_report=1`，检查 SQLite 记录和 Markdown Vault 的路径、frontmatter/id、source/chunk/evidence quote、claim event、topic/deliverable/strategy/backtest/ticket backrefs，并可写入 `wiki/overview/` 诊断报告。
- Lineage：`POST /v1/lineage/rebuild`、`GET /v1/lineage`，重建和查询 `source/chunk -> evidence -> claim -> topic -> deliverable -> handoff -> ticket/backtest/review` 依赖边；source/claim/evidence 从 reviewed 回退、被拒绝、quote 失效，或同 canonical URL 出现新版 reviewed source 依赖时，会沿 lineage 标记下游 topic package / deliverable stale，并进入项目阶段 blocker；JSON/Markdown export 会包含 lineage summary，扩展设置页可一键重建并查看统计。
- Knowledge records：`POST /v1/knowledge/records`、`GET /v1/knowledge/records`、`GET /v1/claims/review-queue`、`GET /v1/claims/:id`、`GET /v1/claims/:id/events`、`POST /v1/claims/:id/review`、`POST /v1/claims/review-batch`、`POST /v1/claims/merge`、`POST /v1/claims/split`、`GET /v1/evidence/:id`、`POST /v1/evidence/:id/review`，支持实体、主张、证据、关系、假设、风险、策略想法和任务的结构化落库、quote context 回看、`citation_valid` 当前引用复验、按 status/source/topic/evidence strength/quote validity 过滤 claim 审阅队列、claim/evidence 人工审阅、批量处理、重复 claim 合并、过宽 claim 拆分和 claim history 审计。
- Topic packages：`POST /v1/topic-packages`、`GET /v1/topic-packages`、`GET /v1/topic-packages/:id`，把一组 claims/evidence 打包成带 canonical claim、重复 claim、supporting/counter evidence、open questions、evidence strength、review/stale 状态的专题包，并写入 `wiki/topics/`。
- Structured extraction：`POST /v1/sources/:id/extract-knowledge` 支持 `auto`、`provider`、`mock`。`auto` 会在 companion service 已配置模型时走 provider-backed 结构化抽取，否则回退确定性 mock；所有模式都会记录 `agent_runs`，包含 prompt/schema/model/provider 版本、token 估算/实际 usage、latency、repair 调用次数，以及在模型设置提供每百万 token 价格时的成本估算。
- Source versioning：`GET /v1/sources/:id/diff` 返回同 canonical URL 上一版本与当前版本的紧凑 unified diff、相似度、增删字符数和版本列表；`POST /v1/sources/:id/reextract` 会创建 `reextract` 类型 job 与单个 job item，同步重跑结构化抽取，并把 source diff、agent run、record counts 和完成/失败事件写入 job ledger。当前这是可用的同步重跑基础，尚未自动重验证所有历史 claim/evidence。
- Export：`GET /v1/export?format=json|markdown`，聚合 companion service 里的 project brief、capture plans、sources、notes、knowledge records、claim events、topic packages、deliverables、strategy handoffs、strategy tickets、backtest results、strategy reviews 和项目仪表盘；扩展导出按钮会优先使用这个接口。
- PDF ingest：`POST /v1/pdfs/extract`，支持本地 PDF 路径和网页 PDF URL。
- YouTube transcript ingest：`POST /v1/youtube/transcripts`，支持手动字幕文本或 segments，保留 video id、时间戳 chunks 和 timestamp citation。
- Learning loop：`POST /v1/sources/:id/learning-pack`、`GET /v1/learning/items`，生成检索练习、Anki 候选、费曼复述、卡点检查和复习队列，落盘到 `wiki/learning/`。
- Claim review：claim 进入 `reviewed` 前必须有至少一条当前仍能匹配 `source_id + chunk_id + quote` 的未拒绝 evidence；evidence 进入 `reviewed` 前也会复验 quote 是否仍在当前 chunk 中。拒绝或失效 evidence 会把已审 claim 拉回 `pending_validation`，避免弱证据继续污染 topic package 和 final 交付物。
- 每次保存笔记时，先把完整来源写入 `原始资料/inbox/`，再把分析结果写入 `wiki/analyses/`。
- `GET /v1/sources/:id` 和扩展 `来源库` 详情可找回原文、raw/summary Markdown 路径、documents、chunks 和关联笔记。
- 来源会记录 `extraction_quality` 和 `quality_flags`，用于提示低文本、截断、分页、登录态或字幕时间戳等质量问题。
- 项目仪表盘的 screen 阶段会把未拒绝/未归档的低质量来源作为 blocker：低文本、截断、登录态缺失、分页未续采、缺标题/URL 等来源不能只靠 `reviewed` 状态放行。
- 扩展 `来源库` 支持调用 `/v1/search` 搜索来源标题/URL、chunk 正文、笔记内容和 tags，并从结果打开来源详情。
- 来源支持 `new/needs_review/read/extracted/reviewed/rejected/archived` 状态，扩展可筛选和标记，index/export/source summary 会显示状态。
- 低质量、不完整或需要续采的来源入库时会直接标记为 `needs_review`；结构化抽取完成后，来源会从 `new/read` 自动推进到 `extracted`；扩展 `待审队列` 会集中显示 `needs_review/new/extracted` 来源并支持接受/拒绝。
- 默认有 Inbox 项目；切换项目后，来源库、待审队列、搜索、笔记、结构化记录、交付物、策略工作台、项目 brief、capture plans、项目仪表盘和导出都按当前项目读取。
- 自动生成并维护 `README.md`、`schema.md`、`CLAUDE.md`、`index.md`、`log.md`。
- SQLite 记录 `projects`、`sources`、`documents`、`chunks`、`notes`、`agent_runs`、`jobs` 等 V0.3+ 所需表。
- 来源入库会用 canonical URL 去掉 tracking 参数并保留 `source_aliases` 与 `source_versions`：同正文不同 URL 合并为同一 source 但保留 alias；同 canonical URL 正文变化会生成新 source 并串成版本历史；重复 capture 带来的新附件会合并进既有附件 ledger。
- 长文会按段落切成 chunks，为后续 map-reduce、多文档研判、引用回链做准备。

## 当前 V0.3 能力

- Codex 插件入口：项目根目录包含 `.codex-plugin/plugin.json` 和 `skills/qc-smart-reader/SKILL.md`，用于让 Codex 按本地 companion service、Chrome extension、Vault 审查规则和交付物引用规则接手项目；新 Vault 会生成 `AGENTS.md`、`CLAUDE.md`、`schema.md`、`index.md` 和 `log.md`。
- 站点 profile：QuantClass/BBS 类论坛、知乎、微信公众号文章、Substack、Medium、Hacker News、Reddit、arXiv、GitHub Issues/Discussions、通用网页。
- 独立站点抽取 registry：`extractors/site_profiles.mjs`，用于把 profile 行为沉淀成可回归的 fixture 测试；扩展会优先注入 `extractors/browser_site_profiles.js` 作为浏览器 DOM profile bundle，失败时回退到 `sidepanel.js` 内联抽取；浏览器 bundle 现在对所有首批站点 fixture 做关键字段 parity 测试，覆盖 GitHub issue/discussion 区分、Reddit thread blocks、微信懒加载图片和代码块去重。
- 抽取预览：profile、质量分、图片数、代码块数、评论数、分页提示。
- 手动正文选择器 fallback：自动 profile 抽取失败或低质量时，可以输入 CSS selector（如 `article`、`main`、`#js_content`）重新读取指定正文容器，结果会用 `manual-selector` profile 和 `manualSelector` stats 标记。
- QuantClass/BBS 抽取会保留楼层、代码块、图片、附件/下载链接和下一页提示；相对图片/附件/分页链接会按当前 URL 解析，分页续页如果第一条就是回复也会保留为评论楼层；当楼层、评论、代码、图片、附件、链接或分页提示被上限裁剪时，capture stats 会保留 `truncated` 和每类 `total/kept/limit`，项目 screen gate 会把未拒绝/归档的截断来源视为质量 blocker；companion service 会把附件写入 `source_attachments` ledger，记录 URL、文件名、楼层/上下文、下载状态、下载路径和 retry error，未落地附件会以 `attachment_missing` 标记进入审查。
- 分页续采：当前来源识别到 `nextPages` 后，来源卡片可一键把分页 URL 写入 Capture Plan 候选池；批量 job item 成功后也会把 `pagination_checkpoint`/`next_pages` 写入服务端 `result_json` 和 `item_checkpoint` event，恢复队列后仍可把待续采分页转成 Capture Plan；capture payload 会把 `next_pages` 落到服务端 `quality_flags`，用于保留分页状态和 screen 阶段 blocker。
- Fixture 已覆盖 QuantClass/BBS 单页、多页续页、知乎、微信公众号文章、Substack、Medium、Hacker News、Reddit、arXiv、GitHub Issues/Discussions 和通用网页 fallback 的基础标题、作者/时间、正文/评论、代码、图片、附件或 PDF 链接。
- 批量 URL 队列：粘贴 URL、加入当前窗口标签、后台逐个打开并保存到 Vault；队列、capture plan、read job 和 source 入库会用 canonical URL 去掉 `utm_*` 等 tracking 参数、fragment、默认端口并排序 query，慢页面、网络/服务瞬时错误、正文短暂为空和未知后台 tab 失败会按类别做有限重试与 backoff，分页未采完和附件未保存会归入可审计分类，并记录 `browser_attempts`；read job event ledger 会记录 `item_heartbeat`、`item_capture`、`item_quality_gate`、`item_review_queue`、`item_extract`、`item_checkpoint`、`job_paused`、`job_resumed`、`job_canceled` 或 `item_status_ignored`，便于复盘每条 URL 是仍在运行、进入人工审查、可进入抽取，还是仍有分页待续采；job summary 会返回 `quality_gate_counts`，侧边栏批量进度会显示需审查数量和主要质量原因；侧边栏支持 1-3 并发上限，显示队列总数、成功/失败/取消、耗时、预计剩余时间和最后 heartbeat。
- 列表页 source discovery：在论坛/文章列表页可直接扫描当前页面的候选 thread/article/arXiv/GitHub/HN/Reddit 链接，按规则打分、去重后写入 Capture Plan 候选池，后续仍需人工 approve/reject 再进入批量队列。
- 登录态策略：不保存账号密码，依赖当前 Chrome 会话；未登录或权限失败时显示失败状态。

## 当前 V0.4 能力

- 本地 PDF 路径导入。
- 网页 PDF URL 下载导入。
- 使用本地 Python worker 解析 PDF 文本层。
- 抽取基础 PDF metadata、标题、作者和逐页文本。
- 按 PDF 页码写入 chunks，并保留 `page_start` / `page_end`。
- 原始 PDF 复制到 `原始资料/papers/`。
- 文本层过少时标记为低置信来源。

## 当前 V0.7 交付物能力

- 本地服务可生成四类 Markdown 交付物：研究报告、PPT 大纲、视频脚本、策略任务单。
- 交付物写入 SQLite `deliverables` 表，并落盘到 `wiki/deliverables/`。
- 创建交付物时可以传入 `source_ids`、claims、strategy 字段、sections/slides，或传入 `topic_package_ids` 从专题包展开已审 claims/evidence。
- 有效 citation 会保留 `source_id`、`chunk_id`、quote、URL/page/floor；无有效引用的 claim 会标记为 `待验证`。
- 每个交付物默认是 `draft`，并带 Ready Gate：引用覆盖、待验证 claim、来源 review 状态、topic package review 状态、未解决冲突和 stale dependency。只有 gate 通过，或有人工风险接受理由时，才能创建 `final`。
- `strategy_task_brief` 的 final 门禁更严格：hypothesis、data contract、signal、backtest window、metrics、risk checks、implementation steps 和 acceptance 必须具体；占位或过泛字段会产生不可绕过的 Ready Gate issue。
- Final 交付物会自动追加 `Evidence Appendix`，集中列出每条 claim 的 source id、chunk id、quote、URL/page/floor/timestamp 等追溯信息。
- Reviewed topic package 已能通过服务端生成 final 研究报告、PPT 大纲、视频脚本和策略任务单；draft、needs_review、conflicted 或 stale topic package 会阻止 final。
- 扩展侧 `交付` 页签可以基于当前来源和最近一次阅读结果调用 `/v1/deliverables`，也可以勾选已审 topic package 作为输入，并刷新展示最近交付物路径。
- 当前是确定性模板层、topic-package-backed deliverable、扩展侧 topic selector、Evidence Appendix 和 Ready Gate 基础版，还没有接入服务端 LLM、人工编辑器或 PPTX 导出。

## 当前 V0.8 策略交接基础

- 本地服务新增 `strategy_handoffs`，可以从 `final` 且 Ready Gate 通过/风险已接受的 `strategy_task_brief` 生成策略交接包。
- 交接包写入 SQLite，并落盘到 `wiki/strategies/`，包含 hypothesis、data contract、signal definition、backtest plan、risk checks、implementation tickets、review checklist、acceptance criteria 和 traceability。
- Handoff 会绑定原始 deliverable、topic package、source、claim 和 evidence ids；`index.md` 和 `GET /v1/export` 会包含这些记录。
- 本地服务新增 `strategy_tickets`，可以把 handoff 拆成数据接入、信号代码、组合回测、风控、回测报告和监控 6 类工程票据；票据写入 `wiki/strategies/tickets/`，并可更新 `open/in-progress/done/blocked/canceled` 状态。
- 创建票据会把 handoff 推到 `implementing`；全部票据 `done` 后，handoff 会进入 `implemented`。
- 扩展侧 `交付` 页签可以从 final 策略任务单创建策略交接包，并在票据工作台里生成/刷新/领取/完成/阻塞/重开实现票据。
- 本地服务新增 `backtest_results`，可以把回测 outcome 标成 `supported`、`weakened`、`falsified` 或 `needs-more-data`，并记录 period、universe、metrics、costs、drawdown、turnover、capacity、artifacts 和 failure notes。
- `weakened`、`falsified`、`needs-more-data` 或带 failure notes 的结果会自动写入一条 linked risk，防止失败策略变成未追踪实验。
- `paper-ready` / `live-ready` 不能由 backtest result 直接设置，必须通过 `strategy_reviews`。paper-ready review 会检查数据泄露、样本外结果、成本、回撤、换手和流动性/容量；live-ready review 会检查 paper trading record、监控计划、kill switch、最大敞口、运维故障预案和人工审批。
- Review 会写入 SQLite 和 `wiki/strategies/reviews/`，并进入 `index.md` 与 `GET /v1/export`。
- 扩展侧 `交付` 页签可以导入回测结果，并提交 paper-ready / live-ready checklist 审查；回测状态不能直接晋升到 paper/live，必须通过审查。
- 当前是 Vault 内交接、票据、回测反馈和风险审查基础版；还没有向外部策略代码仓库写文件，也没有可配置阈值。

## 当前 V0.6 结构化知识能力

- 本地服务已有 `entities`、`claims`、`evidence`、`relations`、`assumptions`、`risks`、`strategy_ideas`、`tasks` 表。
- `POST /v1/knowledge/records` 可以写入结构化抽取结果，并校验 `source_id`、`chunk_id`、quote。
- `POST /v1/sources/:id/extract-knowledge` 提供 provider-backed extractor 和确定性 mock extractor：从 chunks 中生成 claims/evidence/entities/risks/tasks，并写入带 prompt/schema/provider/token/latency/cost 审计字段的 `agent_runs`。provider 模式会要求严格 JSON 输出，非法 JSON 会尝试一次修复；单来源 provider evidence 会被限定到当前 source/chunks，伪 quote、跨来源 chunk、source-only citation 和缺 evidence 的 claim 都只能进入 `pending_validation`。
- 扩展侧 `知识库` 页签可以触发自动结构化抽取，并展示最近的 claims、entities、evidence、relations、assumptions、risks、strategy ideas 和 tasks。
- 有效证据必须同时满足 `source_id`、`chunk_id` 和 chunk 内精确 `quote`；缺证据、source-only、chunk-only、跨来源 chunk 或伪 quote 的 claim 会标记为 `pending_validation`。
- Claim/evidence 审阅工作台已接入：扩展侧可以按状态、quote validity、evidence strength、source id 和 topic package id 拉取待审 claim，查看 quote、chunk context、source/page/floor/timestamp，编辑 claim，填写 reviewer/note/rejection reason，单条或批量接受/拒绝/待验证，也可以把勾选的重复 claim 合并到第一条 canonical claim，或把单条过宽 claim 按 textarea 每行拆成多个 `pending_validation` claim；服务端会保存 reviewer/review_note/reviewed_at/rejection_reason，写入 review/merge/split claim events，工作台会显示事件历史、状态变化和文本前后差异，并禁止没有当前有效 `source_id + chunk_id + quote` evidence 的 claim 被标成 `reviewed` 或 `extracted`。如果已审 evidence 的 quote 不再匹配当前 chunk，会自动降回 `pending_validation` 并 stale 下游依赖。
- Topic package 基础版已接入：服务端可从 claim ids 或项目最近 claims 生成 `wiki/topics/` 专题页，自动汇总 supporting evidence、contradicting evidence、重复 claim、open questions、evidence strength 和 review status；扩展侧可在 claims 列表勾选并生成专题包，export/index 会包含专题包。
- 实体会写入 `wiki/entities/`，结构化导入摘要会写入 `wiki/analyses/`，`index.md` 会列出 entities 和 claims。
- 当前是结构化记录层、source-level 待审队列、claim/evidence 审阅工作台、claim merge/split/history 基础、source version diff 与同步 re-extraction job 台账、topic package 基础版、服务端普通 LLM chat proxy、provider-backed 单来源抽取和 mock 回退层；自动跨来源聚类、完整 claim history 高级回放、异步 source edit/chunk regeneration rerun queue、历史 claim/evidence 自动重验证和 topic 页面增量维护还未完成。

## 当前限制

- PDF 深度解析还不是完整论文精读版本。当前能读文本层和页码；目录、参考文献、图表标题、双栏阅读顺序、扫描件 OCR 还需要后续增强。
- 批量任务已经有服务端 job/item/event 账本、最近任务恢复、失败项重试、stuck-running 恢复、暂停、取消和清理已完成；执行仍主要由扩展端完成，服务端调度和 fixture 回归测试还需要继续加固。
- 本地服务已有 pairing token、Origin allowlist 和服务端模型 Key 配置；实战前仍需要文件访问 allowlist、备份/恢复和敏感数据删除控制。
- 知识库现在已经可以落到本地 Markdown Vault；Chrome storage 只作为服务未启动时的兜底。
- 现在是单次模型调用模拟多 Agent 讨论，成本更低；后续可改成多 Agent 并行独立调用再汇总。

## 对应“知识库闭环”

这个工具现在覆盖闭环的前半段：

1. 收集材料：读取当前网页、论坛帖、选中文本。
2. 论文/报告入口：导入本地 PDF 或 PDF URL，保留页码。
3. AI 甄别：多 Agent 从初学者、老师、专家、工程、审查角度讨论。
4. 初步沉淀：保存为本地 Markdown Vault 条目，支持导出 Markdown/JSON。

后半段可以继续做成自动化：

5. 把多个条目聚类成 `topics/`、`entities/`、`sources/`、`analyses/`。
6. 基于知识库生成 PPT 大纲、视频脚本、策略实现任务单。
7. 对接本地项目目录，把输出直接写入 Markdown 知识库。

## 下一步可加

- 服务端持久任务队列：下一步补服务端调度和更细失败分类。
- 站点/PDF fixture 测试：基础站点 profile fixture 和 QuantClass 多页 smoke 已补齐；下一步补登录墙、折叠内容、删除楼层、PDF 边界样本和更完整的浏览器重启恢复 smoke test。
- 服务端 LLM runtime：普通 chat proxy 和单来源 provider-backed 结构化抽取已接入；下一步补 map-reduce、项目 RAG、更多 provider 失败 fixture，以及项目级 token/成本预算和 dashboard。
- 知识库结构化输出：继续补跨来源聚类、advanced claim history replay、异步 source edit/chunk regeneration rerun queue、历史 claim/evidence 自动重验证和 topic/entity 页面增量更新。
- 项目制流水线：五阶段项目仪表盘、人工确认、project brief/rubric、capture plan approval gate、source quality screen blockers、lineage 重建/查询、stale dependency gate 和 vault doctor 诊断已接入；下一步应补预算追踪、vault doctor 修复/重建模式和 Golden Project E2E。
- 交付物、topic package 创建/选择、结构化抽取、策略任务单严格门禁、策略交接、实现票据工作台、回测结果导入、paper/live 审查和策略风险门禁已经接入；下一步应补 map-reduce/项目 RAG、advanced claim history replay/diff、跨来源聚类、topic/entity 页面增量更新、可配置风险阈值、PPTX/HTML 导出和真实项目 E2E fixture。
