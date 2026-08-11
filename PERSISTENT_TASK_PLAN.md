# 无安装持久任务与断线恢复规划

> 文档性质：持久任务功能的规划、约束和验收记录。它描述过实现路径和候选增强，不等同于全部当前能力；当前接口和开关以 `README.md`、`SKILL.md` 与 `node/` 源码为准。Bridge 保持领域中立，不负责 checkpoint、数据集或模型恢复。

## 1. 目标

将 Codex 会话、网页、SSH 连接和远端训练任务拆分为独立生命周期：

- SSH 空闲过期只关闭传输连接，不终止持久任务；
- Agent 停止观察只返回当前快照，不取消任务；
- 网页关闭、本机断网、休眠或关机后，远端任务继续运行；
- 重新连接后可以恢复任务列表、日志位置、当前状态和取消能力；
- 默认不在远端安装常驻程序，优先使用已有 Slurm、tmux、systemd-run 或 setsid/nohup；
- 所有记录、缓存和日志都有明确容量上限与清理策略，不允许无限膨胀。

## 2. 生命周期拆分

系统分别维护：

- Connection Session：临时 SSH 通道，允许按空闲时间过期；
- Persistent Task：远端持久任务，不属于单个 SSH 或 Codex 会话；
- Observer：网页或 Agent 的临时监控订阅；
- Task Record：本地索引与远端最小恢复清单。

`observe_for_seconds` 只限制一次观察时长。`max_runtime_seconds` 是独立且可选的任务运行限制，默认不设置。观察结束时返回任务快照和日志游标，任务继续运行。

## 3. 无安装启动适配器

按可靠性自动探测并选择：

1. 已有 Slurm；
2. 已有 tmux；
3. 可持续运行的 `systemd-run --user`；
4. `setsid + nohup` 兼容兜底。

能力探测不能只检查命令是否存在。对于 tmux、systemd-run 和 setsid/nohup，应提供一次可选的短时登出存活测试：启动无害测试任务、关闭测试 SSH 通道、重新连接并验证进程身份。未执行或无法完成存活测试时，只能标记为“尽力持久化”，不能给出强保证。

网页必须显示当前启动器和可靠性等级：

- 可靠持久化：Slurm；
- 持久化：tmux 或满足条件的 systemd user service；
- 尽力持久化：setsid/nohup；
- 不支持：服务器策略会在登出后清理用户进程。

启动前执行能力探测，不能把尽力模式描述成强保证。远端 Runner 仅保留为未来可选增强，不作为默认依赖。

## 4. 远端记录布局

远端记录位于当前 SSH 用户自己的主目录，权限为目录 `0700`、文件 `0600`：

```text
~/.remote-control-bridge/tasks/
  active/
    <task-id>.json
  history/
    YYYY/MM/DD/<task-id>/
      task.json
      status.json
      pid.json
      stdout.0.log
      stderr.0.log
      exit-code
```

用户隔离首先依靠远端操作系统账户：不同 SSH 用户拥有不同 home 和文件权限。多个产品用户若共享同一个 SSH 账户，只能通过 `creator_id/workspace_id` 做界面分组，不能视为安全隔离。

任务目录在创建时就固定为 UTC 日期路径，之后永不移动。`active/<task-id>.json` 只保存任务目录位置和最小恢复摘要；任务进入终态时原子删除活动标记，不移动日志或任务目录，避免打开中的文件句柄、日志游标和观察器路径失效。

远端 `active/` 只保存活动任务的小型清单，历史记录按 UTC 日期分区。重新连接时先读取 `active/`，再按用户请求读取指定日期范围，禁止递归扫描全部历史。

任务包装脚本负责原子更新状态、写入 PID/进程组、进程启动时间、服务器 boot ID 和最终退出码。所有 manifest 包含 `schema_version`，更新使用同目录临时文件加原子 rename；损坏或版本未知的记录标记为 `unknown`，不能被自动清理。

## 5. 本地记录与快速索引

本地以 SQLite 为主索引，不为每次列表请求扫描文件系统：

- `owner_key` 使用主机、端口、用户名和已确认指纹的稳定哈希；
- 任务表按 `(owner_key, status, updated_at)` 建索引；
- 历史查询使用游标分页，默认每页 50 条；
- 列表只返回摘要，不读取完整日志；
- SQLite 使用 WAL，写入采用短事务；
- 远端清单、启动器状态和实际进程身份共同构成恢复事实，本地 SQLite 只是快速查询和缓存层；本地状态不得覆盖未经远端验证的任务状态。

本地只缓存有限日志尾部和事件，不复制完整远端日志、checkpoint 或训练输出。

## 6. 日志和事件上限

Bridge 管理的 stdout/stderr 必须有界：

- 默认每个任务 stdout/stderr 合计预算 128 MiB，可按 96/32 MiB 分配并允许用户调整；
- 日志使用单调递增的逻辑 byte offset，物理分片轮转不能重置游标；
- 超过上限后删除最旧分片，并记录 `first_available_offset`、`next_offset` 和 `dropped_before`；
- 活动任务通过随任务生成的轻量日志包装器轮转，不要求安装常驻程序；
- 完成任务的文本日志可在服务器已有 gzip 时压缩；
- SSE/Agent 单次读取默认 64 KiB，并通过 byte offset 或 event cursor 续读；
- 本地事件缓存每任务最多 10,000 条或 4 MiB，先到者生效。

若远端环境缺少实现有界日志所需的基础能力，启动前必须提示用户选择“关闭 Bridge 输出捕获”或明确接受日志可能增长，不能静默无上限写入。

### 日志包装器技术验证门槛

有界日志包装器是本阶段最高风险点，必须先作为独立原型验证，未通过前不进入完整 Task API 和网页实现。默认方案不得要求远端额外安装 Python、Node 或专用日志服务，只能使用能力探测确认已经存在的基础工具；缺少可靠实现条件时自动降级为关闭 Bridge 输出捕获，而不是采用可能阻塞或杀死训练进程的方案。

原型必须证明：

- stdout 和 stderr 独立捕获，合计容量严格有界；
- 能处理高频输出、超长单行、无换行数据、UTF-8 分片边界和任意字节；
- 日志轮转、压缩或清理不会关闭训练进程的输出管道；
- 写盘变慢、磁盘接近配额和观察器断开时，训练进程不会因日志系统阻塞或收到 SIGPIPE；
- 本机断网、Bridge 停止和 SSH 关闭后，远端日志包装器继续运行；
- 轮转前后逻辑 offset 单调递增，多观察器能够独立续读；
- 日志丢弃只影响最旧 Bridge 日志，绝不影响训练输出文件、checkpoint 或任务本身；
- 日志健康状态与任务主状态分离。包装器异常时设置 `logging_status=degraded`，训练主状态仍可进入 `running/completed/failed`，默认继续运行。

压力验证至少覆盖持续产生 512 MiB 输出、每秒大量短行、单行超过 1 MiB、stdout/stderr 并发和轮转期间强制断联。

日志读取响应至少返回：

```json
{
  "first_available_offset": 8388608,
  "next_offset": 8454144,
  "dropped_before": 8388608,
  "content": "..."
}
```

观察器的旧 offset 已被轮转时，从 `first_available_offset` 继续，并明确提示早期日志已按保留策略清理，不能静默重复、错位或返回空日志。

## 7. 默认保留和配额

建议默认值，后续可在设置页调整：

| 数据 | 默认保留 | 默认容量 |
| --- | --- | --- |
| 活动、状态未知、待恢复任务 | 不自动删除 | 受单任务日志上限保护 |
| 用户固定任务 | 不自动删除 | 计入配额并提示 |
| 远端 Bridge 日志和任务清单 | 完成后 30 天 | 每远端用户 2 GiB |
| 本地日志尾部和事件缓存 | 7 天 | 512 MiB |
| 本地任务摘要 | 90 天 | 最多 10,000 条/owner |
| 审计摘要 | 90 天 | 独立配额 |

自动清理严格限制在 Bridge 自己创建的管理目录。不得自动删除：

- checkpoint、模型权重和训练产物；
- 用户指定的 output/workdir；
- 数据集、代码和普通远端文件；
- 活动、unknown、interrupted 待处理或 pinned 任务。

## 8. 清理机制

无安装模式下，本机离线时没有远端常驻清理器，因此采用机会式清理。清理在以下时机触发：

- Bridge 启动后延迟执行；
- Bridge 持续运行期间每 24 小时一次；
- 重新连接远端主机并完成任务对账后；
- 创建持久任务前；
- 任务进入终态后；
- 用户打开任务历史或存储设置时；
- 使用量达到配额 80% 时。

本机离线期间不承诺执行全局清理，磁盘安全依靠每个活动任务的日志硬上限。不得为了实现定时清理而偷偷安装 cron、systemd service 或远端常驻程序。

清理顺序：

1. 已过保留期的本地日志缓存；
2. 已过保留期且未固定的远端 Bridge 日志；
3. 最旧的已完成任务摘要；
4. 达到硬配额时按 LRU 清理已完成且未固定的数据。

每轮清理设置数量和时间预算，避免一次删除阻塞 API。删除采用先标记、再移除文件、最后提交索引的流程；失败项记录重试时间，不能在每次列表请求中反复同步清理。

网页提供：当前占用、预计可释放空间、立即清理、保留天数、固定任务和删除任务记录。删除任务记录与删除用户训练产物必须是两个完全独立的操作。

## 9. 断线对账

重新连接后按以下顺序恢复，远端验证结果优先于本地缓存：

1. 读取远端 `active/` 小型索引；
2. 使用 Slurm Job ID、tmux 会话、PID、进程启动时间和 boot ID 验证状态；
3. 合并本地 SQLite 缓存；
4. 从保存的日志 offset 继续读取；
5. 标记为 `running/completed/failed/cancelled/interrupted/unknown`；
6. 只对 active、unknown 和最近变更任务进行高频刷新。

进程身份验证不能只使用 PID，还必须组合 PID、进程启动时间、进程组、服务器 boot ID 和启动器原生 ID，防止 PID 复用导致任务串线。

远端服务器重启后普通进程不能自动存活。系统应标记 `interrupted`；如需继续执行，由任务发起方依据项目自身规则提交新的普通任务，不能假装原任务仍在运行。

## 10. 取消与进程树

持久任务必须以可识别的独立进程组、调度器 Job 或 systemd unit 启动，取消操作不能只结束最外层 shell 或 torchrun 父进程：

- Slurm 使用 `scancel <job-id>` 并核对最终状态；
- systemd-run 按 unit 停止整个 control group；
- tmux 关闭专属会话后继续验证记录的进程组；
- setsid/nohup 使用已验证的 PGID 向整个进程组发送信号；
- 先发送 TERM，等待可配置宽限期，仍存活时再发送 KILL；
- 发送信号前再次核对 boot ID、PID、启动时间和 PGID，防止 PID 复用误杀无关进程。

对 PyTorch DDP/torchrun、NCCL worker 和 DataLoader 子进程必须进行专门验收：取消后所有相关 GPU worker、CPU worker 和父进程均应退出，GPU 显存应释放，任务才能进入 `cancelled`。存在残留进程时状态为 `cancel_incomplete`，不能显示取消成功。

## 11. 计划 API 和网页

计划增加：

```text
POST /api/v1/agent/tasks
GET  /api/v1/agent/tasks
GET  /api/v1/agent/tasks/<id>
GET  /api/v1/agent/tasks/<id>/logs
GET  /api/v1/agent/tasks/<id>/events
POST /api/v1/agent/tasks/<id>/cancel
POST /api/v1/agent/tasks/reconcile
```

网页新增独立“任务”视图，显示任务 ID、启动器、可靠性等级、远端状态、最后心跳、日志、GPU、重新监控、取消、固定和清理操作。Terminal 继续只承担短命令和交互式操作。任务清单保持领域中立，不保存训练 checkpoint、模型格式或恢复参数。

任务创建接口不得把密码、私钥、Agent token、云密钥或其他秘密写入 manifest、SQLite、审计或展示命令。请求中的命令和环境变量需要进行敏感字段拒绝/脱敏；无法安全持久化的命令只能作为明确标记的短生命周期前台任务执行。

任务创建优先接收结构化 `argv`、工作目录和环境变量白名单，而不是拼接后的 shell 字符串。`display_command` 必须脱敏，远端启动描述只保存执行所必需的信息并使用 `0600` 权限。

## 12. 分批实施与验收

### 开工门槛：日志与任务清单原型

- 完成有界日志包装器原型和压力验证；
- 完成版本化 manifest、固定任务目录、active marker 和原子更新原型；
- 验证 setsid/nohup、tmux 和可用调度器的进程身份恢复；
- 原型失败时先调整设计，不并行扩展网页和完整 API。

### 批次 1：持久任务核心

- Task、Connection Session、Observer 独立状态机；
- `observe_for_seconds` 与 `max_runtime_seconds` 分离；
- 固定 UTC 日期目录、manifest、active marker 和启动器适配；
- 远端优先的重新连接对账；
- 进程组取消、终态和错误恢复；
- Agent Task API，不包含完整历史和存储管理页面。

验收：SSH 过期、网页关闭、Bridge 重启和本机断网不终止持久任务；重新连接后可以恢复状态、日志位置和取消能力。

当前实现进度（2026-08-10）：

- 已实现 feature flag 默认关闭的 Agent Task API：能力探测、结构化创建、活动任务列表、按日期编码 task ID 恢复、offset 日志读取和身份校验取消；
- 已补充 Agent 侧通用分流规约：短命令使用 Job，预计超过 120 秒或需要脱离会话的工作使用 Persistent Task；创建返回后最多观察 30 秒，之后只返回状态、有限日志和 offset，不取消远端任务，后续按 task ID 或历史继续观察。该规约不增加任务 API 的领域字段，也不改变远端运行时限；
- 已新增 `tasks:read/tasks:execute/tasks:cancel` 独立授权 scope，旧授权不会自动获得新增能力；
- 远端记录固定写入 `~/.remote-control-bridge/tasks/history/YYYY/MM/DD/<task-id>`，active 目录只保存活动指针；
- 启动器按会话能力选择 systemd-run user 或 setsid/nohup，并返回可靠性等级；未验证或不存在的启动器不会暴露为可用；
- 当前仅实现活动任务发现，完整历史 SQLite 索引、reconcile、observer 时限、配额与网页任务中心仍属于后续工作；
- Task API 仍需在用户从宿主终端显式启用并重启服务后进行真实端到端验证，现有短命令 API 未被替换。

真实 Agent Task API 验收（2026-08-10）：

- feature flag 与新增 task scopes 生效，能力端点正确识别 systemd-run user、setsid/nohup，并将 `Linger=no` 标为 `best_effort`；
- setsid/nohup API 任务创建、活动列表、按 ID 查询、运行中 stdout/stderr、byte offset 续读、取消请求与最终 cancelled 全部通过；
- 取消接口先返回 `cancelling`，wrapper 随后写入 cancelled、退出码 143 并删除 active marker；
- systemd-run user API 任务自然完成通过，active marker 删除后仍可由日期编码 task ID 直接读取历史终态和日志；
- 实测发现本机与远端墙钟约有数十秒偏差，本地 manifest 时间可能晚于远端 status 时间；任务 ID、`created_at` 和初始 status 已改为使用远端 `date -u`，禁止依赖跨机器墙钟推断状态先后；
- 时钟修复后的完整 Node 测试为 38/38 通过，需重新加载 Session 服务后完成最终远端时间一致性检查。
- Session 服务重启后获得新 session ID，仍可直接读取重启前的 cancelled 与 completed 历史任务，确认恢复不依赖旧 Session 内存；
- 远端 UTC 修复最终验收通过：manifest、首条日志、最终 status 与末条日志均使用同一远端 UTC 时钟，状态时间单调且与实际运行时长一致；
- 最终探针 completed、退出码 0、active 列表归零。批次 1 的 Agent Task API 最小闭环及当前主机远端验收完成。

批次 2 当前实现进度（2026-08-10）：

- 新增本地 SQLite WAL 索引，按确认 SSH binding 的 SHA-256 `owner_key` 隔离，保存非敏感 manifest/status 摘要；
- 新增稳定的 `(created_at, task_id)` opaque cursor 分页、状态过滤和 Session 进程重开持久性测试；
- Node 22+ 可使用内置 `node:sqlite`；Node 20 缺少该模块时核心远端 Task API 继续可用，历史端点明确返回索引不可用，不回退为无限文件扫描；
- 新增 `GET /agent/tasks/history` 与 `POST /agent/tasks/reconcile`；
- 新增 `GET /agent/tasks/storage` 与 `POST /agent/tasks/maintenance`，用于查看和执行本地 SQLite 摘要维护；
- 新增只读 `GET /agent/tasks/cleanup-preview`；远端统计只扫描固定 Bridge 管理树，结果缓存 60 秒，并限制最多 10,000 个任务和 100,000 个目录项；
- 新 SSH Session 建立后一秒自动对账远端 `active/`，同时保留手动对账入口；
- 对账组合验证 boot ID、wrapper PID/PGID/启动时间和训练 PGID/启动时间：进程消失标记 interrupted，身份不匹配或记录不完整标记 unknown；
- 启动宽限期使用远端 UTC 计算，不混用本机与远端墙钟；
- 本地摘要已按 owner 实施 90 天保留期和最多 10,000 条终态记录限制；仅清理 `completed/failed/cancelled`，保护 `active/unknown/interrupted`；
- SQLite 使用 WAL 自动 checkpoint 和 64 MiB journal size limit；本轮维护不会删除任何远端记录、日志或用户训练产物；
- 当前完整 Node 测试为 43/43 通过；真实 history/reconcile 已验收；Session 重载后的 storage/maintenance 验收通过：维护前后均为 4 条摘要（2 completed、1 cancelled、1 interrupted），本地过期和超额删除数均为 0，远端删除数为 0，interrupted 记录仍可发现并按 ID 恢复。
- 远端空间统计和清理预演已完成真实验收：扫描 4 条任务记录、1 个 active marker 和 27,560 bytes，结果完整、无截断、无未知目录项、无错误；默认策略与最激进合法参数均保持 `dry_run=true`、`deletion_enabled=false`、删除数 0，预演前后 4 个任务 ID 完全一致。损坏记录仍计入占用但永不进入候选；默认按 30 天和 2 GiB 生成终态记录候选，当前没有任何远端删除路径。
- 新增任务固定/取消固定和显式单条记录删除实现：固定标记同步进入 SQLite，并从本地自动维护和远端预演候选中排除；删除权限为独立 `tasks:delete`，默认不开启，旧授权不升级；删除要求完整 task ID 与 `bridge_task_record_only` 二次确认，只接受无 active marker、未固定的 completed/failed/cancelled 记录，并拒绝未知文件、嵌套目录、特殊文件和所有未决状态。当前 46/46 Node 测试通过；默认关闭模式真实验收通过：能力与存储接口均报告删除关闭，删除请求返回 404，固定后远端查询、SQLite 历史和预演分别显示 pinned=true、pinned_rows=1、protected.pinned=1，取消后全部恢复，最终仍为 4 条记录和 27,560 bytes，全程删除数为 0。

### 批次 2：日志与存储

- 有界日志正式集成、全局 offset、多观察器续读；
- SQLite 快速索引、游标分页和远端事实校验；
- 配额、固定任务、机会式清理、压缩和存储统计；
- 记录损坏、日志缺口和配额耗尽时的降级状态。

验收：持续高输出和大量历史任务下，磁盘有界、列表查询稳定，清理不会触碰用户产物或活动任务。

### 批次 3：网页任务中心

- 运行中、历史、失败、失联、可恢复任务视图；
- 日志续读、GPU、重新监控、取消和固定；
- 启动器可靠性、最后验证时间、日志缺口和存储占用提示；
- 清理设置、立即清理和任务记录删除。

验收：用户不依赖原 Codex 会话或终端标签即可发现、监控和管理远端任务。

当前实现与验收进度（2026-08-10）：

- 已在浏览器工作区新增独立“任务”标签，提供当前任务与历史任务分段视图、历史状态筛选和稳定 cursor 分页；
- 已接入远端/本地存储统计、任务详情、stdout/stderr 独立 byte offset 续读、运行中日志自动跟随、任务取消、固定/取消固定和只读清理预演；
- 网页不展示任务记录删除按钮；后端单条记录删除仍受独立 `tasks:delete` 和默认关闭 feature gate 保护，当前运行服务未开启删除；
- 新标签页在缺少 `sessionStorage` 时，可通过 `/api/v1/agent/session` 安全接管仍被 Agent 授权的同一 SSH 会话；授权不存在或失效时回退到普通登录，不恢复或保存密码；
- 真实远端验收读取到 4 条记录、27 KiB 管理空间和 4 条本地历史，详情、日志、固定/取消固定与清理预演均通过，最终固定数恢复为 0，预演无候选且未删除任何记录；
- 桌面 `1280x720` 下任务中心底部与浏览器底部精确对齐且页面无溢出；低高度 `1280x600` 下触发最小高度与工作区滚动保底，标签保持稳定尺寸；移动端 `390x844` 下列表和详情纵向堆叠，无水平页面溢出或控件重叠；
- 浏览器控制台无警告或错误，完整 Node 回归测试为 47/47 通过。
- 已将任务状态观察与日志观察拆分：选中的未终态任务每 5 秒独立核验远端状态，关闭日志自动续读不会停止状态核验；离开任务标签、撤销 Agent 授权或任务进入终态后自动停止，异常时退避到 10 秒重试，避免完成任务仍长期显示运行中并持续轮询。
- 已新增任务详情 GPU 观察：新任务把数字 `CUDA_VISIBLE_DEVICES` 归一化为非敏感 `manifest.resources.gpu_devices`，不复制完整环境、变量名或 opaque selector；网页按提示过滤最新主机 GPU 快照。旧任务和无法映射的选择器明确显示为未绑定主机快照，不能据此宣称 GPU 进程属于该任务。真实旧记录验收显示 6 张主机 GPU、无横向溢出；完整 Node 回归为 48/48 通过。新清单字段需重载 Session 后才会写入后续新任务。
- Session 重载后的真实 GPU 提示验收通过：通过 loopback Agent API 创建一条临时任务，仅声明 `CUDA_VISIBLE_DEVICES=3,4` 并运行无 GPU 负载命令；远端 manifest 只包含归一化的 GPU 资源提示，任务完成且退出码为 0。网页历史详情只渲染声明的 GPU 卡，桌面任务中心仍与 720 px 浏览器底部对齐且无页面溢出。
- 2026-08-11 完成领域边界收紧：撤回曾短暂加入的训练 checkpoint 字段、查询端点和网页面板，Bridge 不再建模项目产物或恢复语义，只在 Skill 中约束 Agent 使用项目提供的普通命令与精确文件路径。Session 重载后旧端点返回 404；通用验收任务 completed、退出码为 0、manifest 仅包含执行与生命周期字段。旧测试记录保持不变但不会渲染专用 UI。

批次 3 的网页发现、监控、取消、固定、GPU 和只读存储观察闭环已经完成。Bridge 保持通用任务基础设施边界，不建模项目恢复语义；需要继续执行时由 Agent 按项目规则创建普通新任务。清理策略编辑和网页记录删除仍属于后续增强。

当前封板状态（2026-08-11）：Persistent Task 核心路径、Agent API、网页任务中心、远端优先对账、SQLite 历史、日志 offset、取消、固定、存储保护和断联恢复均已接入。故障测试默认只使用本地 fake、临时目录、隔离端口和临时子进程，不对真实远端执行重启、磁盘填充、记录损坏或守护进程安装。完整 Node 回归为 60/60 通过。清理策略编辑和网页记录删除是可选增强，不属于通用长任务闭环的完成门槛。

## 13. 故障与压力测试矩阵

封板覆盖状态：

- [x] Codex 停止观察、网页关闭和 SSH Session 生命周期与 Persistent Task 分离；
- [x] Bridge、Session 和 Control 使用隔离端口分别重启；
- [x] 本机断联、休眠或关机后的恢复语义通过服务实例替换与历史重开模拟；
- [x] SSH exec 超时、流错误、SFTP 中断和资源关闭；
- [x] 通过 boot ID 变化模拟远端服务器重启，任务标记 `interrupted`；
- [x] PID/PGID/启动时间变化和身份记录不完整的保护行为；
- [x] manifest/status 损坏、未知版本、active marker 悬空和 SQLite 重开；
- [x] 多观察器独立日志 cursor、服务实例替换后的 offset 续读；
- [x] 日志高速增长、轮转、容量压力、只读/配额写入失败的本地故障注入；
- [x] setsid/nohup、systemd-run 和 torchrun 取消的既有验收记录；
- [x] pinned、unknown、interrupted、active 和损坏记录不进入自动清理；
- [x] 记录删除被限制在 Bridge 管理目录，拒绝未知文件和所有用户产物路径；
- [ ] tmux 和 Slurm 仅在具备相应能力的环境验证；未验证时不暴露为可用启动器，不阻塞核心封板。

## 14. 历史实施顺序

1. 原型验证版本化 manifest、固定任务目录、active marker 和原子状态更新；
2. 原型验证有界日志、全局 offset、轮转、断联存活和异常降级；
3. 验证启动器能力探测、登出存活测试及 Slurm/tmux/systemd/setsid 进程恢复；
4. 原型门槛通过后，建立独立 Task/Connection/Observer 状态机和 Agent Task API；
5. 实现进程组取消、远端优先对账和日志游标恢复；
6. 实现本地 SQLite 索引、分页、配额和机会式清理；
7. 实现网页任务中心；
8. 执行完整故障、DDP 取消、记录损坏和配额压力测试，全部通过后再替换现有长任务路径。

## 15. 原型与验收记录

记录日期：2026-08-10。

以下为早期原型和接入过程记录；当前核心路径已经接入：

- `PersistentTaskStore`：版本化 manifest、固定 UTC 日期目录、active marker、原子状态更新、终态仅删除活动标记；
- `SegmentedLogStore`：任意字节写入、固定分片、容量上限、单调全局 offset、旧 cursor 丢弃边界、重启续写和并发 append 串行化；
- detached Bash wrapper：结构化 argv、环境变量敏感字段拒绝、FIFO 持续读取、固定容量分片、进程身份记录和原子终态；
- 日志健康已从任务主状态拆分为 `logging_status=ok/degraded`；日志失败时持续排空 FIFO，子任务可以正常完成；
- 512 MiB 本地压力验证完成：写入 536,870,912 bytes，保留 134,217,728 bytes，4 个分片，`first_available_offset=402,653,184`，`next_offset=536,870,912`；
- 正常 wrapper smoke：任务 completed、退出码 0、stdout 保留 2 个分片、stderr 保留 1 个分片、active marker 删除；
- 强制 stdout 日志失败 smoke：任务仍 completed、退出码 0、`logging_status=degraded`、active marker 删除；
- Linux 远端能力探测通过：Bash 4.4.20、GNU dd 8.28、mkfifo、cat、wc、setsid 和 nohup 均可用；
- `setsid + nohup` 远端原型通过：Agent 启动命令 85 ms 内结束，此时 wrapper 仍处于 `starting`，之后独立进入 completed；
- 远端 320 KiB stdout 验证完成：最终只保留两个 64 KiB offset 分片，stderr 独立落盘，退出码 0，active marker 删除；
- 远端 stdout 写入故障注入通过：输出路径不可写时持续排空 FIFO，任务仍 completed、退出码 0、`logging_status=degraded`；
- 当前主机未安装 Slurm/tmux；`systemd --user` 可用，transient unit 在 395 ms 内返回，运行中可按 unit 名查询，wrapper 最终 completed；
- systemd 237 在任务完成后立即回收 transient unit，`LoadState=not-found`；历史终态必须从远端 manifest/status 恢复，不能依赖 unit 持续存在；
- 当前远端用户 `Linger=no`，因此 systemd user manager 在最后一个登录会话退出后的存活能力仍未得到保证，只能暂标为尽力持久化；
- Bridge SSH 会话断开恢复验证通过：旧会话关闭并立即撤销 Agent 访问，重新连接获得新 session ID；setsid/nohup 与 systemd-run 两个 wrapper 均在断开后写入 completed，退出码 0、`logging_status=ok`、active marker 删除；
- 重连后仅依靠固定远端目录、manifest/status 和日志文件即可恢复两个任务的终态，不依赖旧 SSH channel、旧 Agent job 或本地内存对象；
- DDP 取消验证通过：双卡 torchrun 启动 2 个 GPU rank 和 4 个持久 DataLoader worker；身份校验后的 TERM 触发 torchrun 向 rank 转发，全部已记录 PID 退出，GPU 3/4 显存回到 0，任务终态为 `cancelled`；
- wrapper 监督进程与训练子树已拆分 PGID；取消时监督进程和日志 reader 保持存活，负责写入最终 cancelled、退出码、日志状态并删除 active marker；
- torchrun 会让 rank 进入新的 session/PGID，不能仅凭顶层 PGID 推断所有后代都收到信号；取消完成后必须额外核对进程树、命令身份和 GPU 占用，存在残留时标记 `cancel_incomplete`；
- 修复 FIFO 实时日志延迟：移除 `dd iflag=fullblock`，不再等待聚合满 1 MiB；远端 `LIVE_READY` 已在任务仍为 running 时可读取，结束后继续包含 `LIVE_DONE`；
- 该原型阶段当时的 Node 测试为 34/34 通过，正常与强制日志降级 wrapper smoke 均通过；当前封板回归数字见本计划第 12 节末尾。

原型过程中修正的问题：

- Bash `${...}` 与 JavaScript 模板插值冲突；
- 任务完成和日志降级不能共用一个状态字段；
- 在 EOF 边界探测前清理旧分片会少保留一个有效分片；
- 分片文件名改为全局起始 byte offset，重连后可直接恢复游标；
- 语法检查和后台启动不能写成 `check && launch &` 复合列表，否则后台 shell 可能继续占用 SSH exec channel；实现必须分两次 exec，启动命令只包含已验证的 detached launch；
- 启动命令结束后的短窗口内 `status.json` 可能尚未出现；对账应将“active marker 存在但 status 暂缺”识别为 `launching`，按退避策略重试，不能立即标记 failed 或 unknown；
- `dd iflag=fullblock` 会让低流量日志在 FIFO 内等待到 1 MiB 或 EOF，破坏实时观察；日志读取必须允许短读，并以实际 chunk 字节数推进 offset；
- wrapper 与训练子树共用 PGID 时，取消会同时杀死状态监督器；训练命令必须拥有独立 PGID，监督器留在组外完成日志收尾和终态写入。

仍未通过或当前主机不具备条件：

- systemd user manager 在 `Linger=no` 且该用户最后一个登录会话退出条件下的存活测试；
- tmux 和 Slurm 适配器仍需在具备相应能力的环境验证；
- 通用非 torchrun 命令若自行脱离进程树，setsid/nohup 适配器仍只能在取消后通过残留检查标记 `cancel_incomplete`，不能宣称 cgroup 级强保证。

以上远端验证全部通过 loopback Agent 和 session-scoped SFTP API 完成，没有绕过 Bridge 直接 SSH。Bridge 自身 SSH 会话断开和当前主机可用的 setsid/nohup、systemd-run、DDP 取消门槛已经通过；结束该远端用户的其他无关登录会话不在 Bridge 的操作边界内，因此 `Linger=no` 下的最后登录退出保持未验证。Task API 现已按 feature flag 默认关闭的方式接入；每个启动器仍必须独立探测、验证和启用，未验证的 tmux/Slurm 不得暴露为可用选项，也不能替换现有短命令路径。
