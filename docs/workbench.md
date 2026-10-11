# 项目工作台

工作台基于 `templates/remotion-v1` 和 pi Goal。只展示通过工作台新建的项目，不迁移已有生成记录。项目 ID 同时作为作品 ID；空项目也可以持久保存。

## 一条创作消息的流程

1. 浏览器提交本轮想法或调整、唯一消息编号、可选图片和解说时间轴。
2. 服务在项目锁中保存用户消息、助手任务占位和任务关联，返回任务 ID。
3. 首轮创建固定模板工程与原生 pi session；之后直接在同一工程、同一 session 中继续开发，保留尚未发布的开发进展。
4. 当前用户消息直接通过 pi RPC `prompt` 发送。`GOAL.md` 更新本轮要求，`conversation.json` 保存工作台对话供必要时查阅，连续上下文由原生 session 负责。
5. pi 自主开发，宿主检查并反馈，直到完成实际媒体验收，或保留失败现场。
6. 成功后发布成片与源码包，任务结束写入真实助手总结和版本卡片。图片用途澄清也作为助手消息保存，用户的下一条回复继续这轮需求。

一个项目始终使用一个工程目录和一个 pi session。新消息使用新任务，但加载同一原生 session 文件与 ID；验收修复也继续该会话。用户消息携带稳定编号，恢复任务会扫描原生 session 的用户记录，已提交的要求不重复发送；上下文压缩后仍可查询原始记录。空闲时 pi 进程可以关闭，服务重启后重新加载原文件。身份登记文件与原生 session 不一致时明确报错，不会静默新建 session。

通过验收后先结束开发进程，再把源码、素材、计划、成片和源码包复制到工程外的版本快照并原子发布。后续开发不能修改历史快照。用户可以明确要求改变时长、构图、画面与动画；导入的解说时间轴在作品发布后锁定。

## 持久化与并发

- `artifacts/workspaces/<projectId>.json`：名称、初始想法、图片、时间轴、消息、活动任务。
- `artifacts/jobs/<jobId>.json`：完整输入、检查点、状态、阶段、轮次、错误。
- `artifacts/projects/<projectId>/workspace/`：固定工作工程、素材、原生会话、当前输出与检查记录。
- `artifacts/projects/<projectId>/workspace/control/session.jsonl`：项目唯一的原生 pi session。
- `artifacts/projects/<projectId>/workspace/.video-flow/session.json`：宿主登记的 session ID，模型不能修改。
- `artifacts/projects/<projectId>/<jobId>/`：发布版本的源码、素材、成片、源码包与验收记录快照；不包含会话或代理配置。
- `artifacts/generations/<projectId>.json`：已发布作品与历史计划。
- `artifacts/revisions/<projectId>-vN.mp4`：旧版本成片；每个版本的工程包独立保存。

项目写入使用串行锁及临时文件原子替换。同一项目只允许一个生成任务，不同项目可同时生成。完成状态通过任务结束回调同步；读取项目时还会与任务记录对账，恢复服务重启后尚未同步的对话。

提交重试使用 `clientMessageId` 去重。任务只允许最新一轮操作项目 session 和工作工程，旧失败任务在后续对话已提交后不能重新开发或发布。调整提交和发布还检查上一版计划哈希，避免覆盖后来版本。日志、任务状态与验收记录包含实际 `piSessionId`，项目完成后也保存该 ID。

浏览器记住选中的项目和文本、时间轴草稿。未提交的图片保存在页面内存中，刷新后不会恢复。项目切换期间各项目保留自己的草稿；任务状态轮询与实时日志按项目和任务关联。历史版本仅供查看，继续调整需切回最新版本。

## 执行历史

对话区顶部的「pi 执行历史」直接读取当前项目的原生 session，展示 pi 发言、思考记录、工具调用参数、工具执行结果、宿主反馈与上下文压缩摘要。已有项目的记录可以直接回看，刷新或服务重启后保留。此视图读取所有已保存记录，压缩上下文不会删除原始历史。

初次加载最近 60 条，通过字节游标向前加载更早记录；自动更新只读取追加部分。工具结果和较长内容可展开；打开历史时每 3 秒刷新，向上浏览暂停跟随，点击「跟随最新」回到末尾。单块内容超过 80000 字符时页面截取并提示，可下载完整的规范化 JSONL 历史。展示和下载均去除会话签名、系统配置与 API 凭据。正在生成且尚未写入 session 的模型消息会在保存后出现。

项目运行日志从全部日期的日志文件加载，支持向前分页；实时日志追加至当前列表，按 ID 去重。下载日志包括该项目全部日期的保存记录。运行日志用于查看宿主准备、渲染、验收和失败情况，原生会话用于查看 pi 的实际开发过程。

## API

| 接口 | 用途 |
| --- | --- |
| `POST /api/projects` | 创建空项目，输入可选 `title` |
| `GET /api/projects` | 项目摘要、状态、版本数 |
| `GET /api/projects/:id` | 对话、当前任务、版本列表、最近已发布计划 |
| `GET /api/projects/:id/history` | 原生 pi 执行历史，支持 `before` / `after` 字节游标和 `limit`（默认 60） |
| `GET /api/projects/:id/history?download=1` | 下载完整的规范化 pi 执行历史，JSONL 格式 |
| `POST /api/projects/:id/rename` | 修改项目名称 |
| `POST /api/projects/:id/messages` | 提交 `{content, clientMessageId, images?, storyboard?}`，返回项目及任务 |
| `GET /api/projects/:id/assets/:index` | 项目图片 |
| `GET /api/projects/:id/versions/:number` | 指定版本计划 |
| `GET /api/projects/:id/versions/:number/video` | 指定版本 MP4，支持 Range |
| `GET /api/projects/:id/versions/:number/source` | 指定版本源码包 |
| `GET /api/jobs/:id` | 任务阶段、轮次、状态、结果 |
| `POST /api/jobs/:id/cancel` | 取消并保留工程 |
| `POST /api/jobs/:id/resume` | 继续同一任务 |
| `GET /api/logs?projectId=:id` | 项目全部日期的日志分页，支持 `before` 记录 ID 与 `limit`（默认 100） |
| `GET /api/logs/download?projectId=:id` | 下载当前项目全部日期日志 |
| `POST /api/generations/:id/audio` | 上传配音 |
| `POST /api/generations/:id/export` | 重新封装成片并合成配音 |

图片最多 6 张，累积归属项目；浏览器压缩为最长边 1600px 的 WebP。生成工程中的 `assets.json` 记录文件名与索引。图片用途由 pi 判断，无法判断时提问。当前文本模型配置不提供图像视觉理解。

## 当前边界

只有新模板工程工作流。没有自动 TTS、项目删除、多人权限、云端任务或历史版本分支编辑。工作台展示宿主保存的实际检查结果，是否达到内容和视觉目标仍需观看成片判断。macOS 本机隔离与模型输入能力边界见 pi Goal 架构说明。
