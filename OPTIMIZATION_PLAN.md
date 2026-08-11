# Remote Control Bridge 优化方案

状态：阶段 1 已完成，阶段 2 待实施  
制定日期：2026-08-08  
适用目录：`remote-control-bridge/`

## 1. 当前基线

当前版本已经具备以下能力：

- 仅监听 `127.0.0.1` 的本地 Web Bridge。
- 页面输入 SSH 主机、端口、用户名和临时密码。
- SSH 主机指纹首次确认与 Bridge 独立 `known_hosts`。
- 密码只用于握手，不写入配置、日志或磁盘。
- Paramiko 认证失败时使用 AsyncSSH 回退。
- 主机、磁盘和 NVIDIA GPU 状态仪表盘。
- 页面模拟终端和本地 Agent 命令 API。
- 命令异步执行、任务 ID、最多四个按需终端槽位。
- Agent 授权默认关闭，断开 SSH 后立即失效。

当前主要不足：

- 任务不能主动取消。
- stdout/stderr 只能在命令结束后读取，缺少实时输出。
- 状态只有 `running/completed/failed`，不能区分取消和超时。
- Bridge 重启后任务元数据丢失。
- Agent 授权是会话级开关，缺少独立 capability token 和权限范围。
- 页面终端是独立命令窗口，不是真正的交互式 PTY。
- 没有 SFTP 文件浏览、上传、下载和编辑能力。
- 仪表盘缺少 CPU、内存、网络、GPU 进程和历史趋势。
- 单元测试覆盖核心校验，但缺少真实 SSH 集成测试和浏览器端到端测试。

## 2. 优化原则

1. 密码只存在于 SSH 握手调用栈中，不进入任务、终端或持久化状态。
2. 用户终端和 Agent 使用不同交互模型：用户使用 PTY，Agent 使用结构化任务 API。
3. 并行能力必须有上限。默认每个 SSH 会话四个终端槽位，并增加全局并发上限。
4. 长任务不依赖单个 HTTP 请求存活，输出使用流式通道和有界缓冲。
5. 任意命令能力必须由短期授权控制，并支持立即撤销。
6. 文件访问默认限制在远端用户主目录，敏感路径继续拒绝。
7. 每个阶段必须包含测试、迁移和回退方式，避免一次性重写。

## 3. 目标架构

```text
Browser UI
  |-- REST: session, status, jobs, files
  |-- SSE: job stdout/stderr/status
  `-- WebSocket: interactive PTY

Local Agent
  |-- scoped capability token
  |-- REST: submit/cancel/query jobs
  `-- SSE: consume job events

Bridge Core
  |-- SSH session pool
  |-- bounded terminal/channel allocator
  |-- job state machine
  |-- output ring buffers
  |-- capability authorization manager
  |-- SFTP service
  `-- metrics collector

Remote Server
  |-- SSH exec channels for Agent jobs
  |-- SSH PTY channels for user terminals
  `-- optional tmux/Slurm/systemd-run for durable jobs
```

## 3.1 控制面与数据面分离

这是解决“功能服务重启后不想重新授权”的推荐方案。

### 稳定控制面

`bridge-control` 只负责身份和授权，不实现远程功能：

- 管理用户授权请求、Agent capability token 和撤销。
- 使用 Windows DPAPI 或 Credential Manager 保存授权状态，不保存明文密码。
- 维护短期 token 的签名密钥、有效期、权限范围和撤销列表。
- 通过 Windows Named Pipe 或仅本机回环接口向数据面发放授权结果。
- 作为 Windows 服务或任务计划常驻，功能代码更新不重启它。

### 稳定会话面

`bridge-sessiond` 只负责 SSH 生命周期：

- 持有 SSH 连接、主机指纹和终端/channel 槽位。
- 维护任务、SSE、PTY 和 SFTP 的底层连接。
- 功能 API 重启时，已有 SSH 会话和远程任务继续运行。
- 只接受控制面签发的 capability，不参与用户界面和业务编排。

### 可更新功能面

`bridge-api` 和前端页面负责仪表盘、命令编排、文件视图和 Agent API：

- 可以独立重启、升级和回滚。
- 不持有 SSH 密码或长期私钥。
- 通过本机 IPC 调用 `bridge-sessiond`。
- 校验 capability 的签名、作用域和有效期，不需要每个功能模块访问授权数据库。

### 重启语义

| 重启对象 | 是否重新授权 | SSH 会话是否保留 | 说明 |
| --- | --- | --- | --- |
| 前端页面 | 否 | 是 | 重新发现当前授权会话即可 |
| `bridge-api` | 否 | 是 | 控制面和会话面继续运行 |
| `bridge-sessiond` | 取决于凭据 | 否/可重连 | 推荐使用 SSH 密钥自动重连 |
| `bridge-control` | 需要恢复授权状态 | 是 | DPAPI 恢复 token 和撤销列表 |
| Windows 主机重启 | 取决于凭据 | 否 | 密钥或加密凭据可自动重连；纯临时密码不能安全自动重连 |

### 凭据选择

推荐顺序：

1. SSH 公钥 + Windows Credential Manager 保存私钥口令。
2. 未加密的专用低权限 SSH 密钥，仅存放在受限目录，并限制远端 `authorized_keys` 权限。
3. Windows DPAPI 加密保存临时密码，仅在用户明确接受“本机可自动重连”时启用。
4. 纯密码临时会话：重启后要求用户重新输入密码，这是最安全也最诚实的行为。

控制面不参与命令执行、文件传输、GPU 采集或终端渲染；它只回答“这个请求是否有权操作哪个会话”。这样功能开发可以独立迭代，授权边界也不会随着功能增加而扩散。

## 4. 分阶段实施

### 阶段 1：可靠的任务执行

优先级：P0  
目标：让现有模拟终端和 Agent API 支持取消、实时输出和完整状态。

实施状态：已完成（2026-08-08）。

已验证：SSE 逐块输出、取消任务、取消后释放终端槽位、超时状态、四槽位限制和全局八任务限制。

任务状态机：

```text
queued -> running -> completed
                  -> failed
                  -> cancelled
                  -> timed_out
```

接口调整：

```text
POST   /api/v1/sessions/<session>/commands
GET    /api/v1/sessions/<session>/jobs/<job-id>
DELETE /api/v1/sessions/<session>/jobs/<job-id>
GET    /api/v1/sessions/<session>/jobs/<job-id>/events

POST   /api/v1/agent/commands
GET    /api/v1/agent/jobs/<job-id>
DELETE /api/v1/agent/jobs/<job-id>
GET    /api/v1/agent/jobs/<job-id>/events
```

实现要求：

- SSE 事件类型包含 `status`、`stdout`、`stderr` 和 `end`。
- 每个输出流使用 4 MiB 环形缓冲，持续读取并丢弃超限的旧数据。
- 任务对象保存 SSH channel/process 句柄，用于取消和超时终止。
- 取消操作必须关闭对应 channel，并在短时间内释放终端槽位。
- 默认超时 120 秒，单次允许 1 到 3600 秒。
- 每个会话最多四个运行槽位，全局默认最多八个运行任务。
- 达到上限时返回 `409 Conflict`，不能静默排队无限任务。
- 页面显示开始时间、运行时长、退出码、截断状态和停止按钮。

验收标准：

- `sleep 60` 可以在两秒内被取消，状态为 `cancelled`。
- 超时任务状态为 `timed_out`，而不是普通 `failed`。
- 每秒输出一行的命令能在页面逐行出现。
- 终端 1 忙碌时，第二条命令自动进入终端 2。
- 四个终端均忙碌时，第五条命令返回明确的 `409`。
- 取消、超时和网络断开后不遗留永久 busy 槽位。

### 阶段 2：Agent capability 授权

优先级：P0  
目标：替换当前仅依赖本地开关的宽泛授权。

设计：

- Agent 首先创建一次性授权请求并保持长轮询。
- 页面显示请求来源、请求权限和有效期。
- 用户批准后，只有原请求方获得随机 capability token。
- Token 仅保存在 Bridge 内存和 Agent 当前任务中，不写磁盘。
- 请求头使用 `Authorization: Bearer <token>`。
- 支持权限范围：`status:read`、`jobs:read`、`jobs:execute`、`jobs:cancel`、`files:read`、`files:write`。
- 默认有效期 30 分钟，SSH 断开或页面撤销后立即失效。
- 对认证失败、命令提交和取消操作做速率限制。

验收标准：

- 未授权本地进程无法发现 SSH 会话或执行命令。
- 只读 token 无法提交或取消任务。
- 撤销 token 后，下一次 API 请求立即返回 `401/403`。
- 审计记录只保存时间、操作类型、目标主机和结果，不保存密码及完整命令输出。

### 阶段 3：真实用户终端

优先级：P1  
目标：为页面用户提供真正的交互式 SSH PTY，同时保留 Agent 结构化任务 API。

实现要求：

- 使用 WebSocket 传输 PTY 输入和输出。
- 支持终端尺寸变化、方向键、Ctrl+C、颜色和交互式程序。
- 页面终端使用成熟的终端渲染库，例如 xterm.js。
- 每个 SSH 会话最多四个 PTY/exec 槽位共享同一并发预算。
- 标签关闭时先确认是否仍有前台任务，再关闭远端 PTY channel。
- Agent 不直接操作 PTY，避免依赖脆弱的屏幕文本解析。

验收标准：

- `cd`、`conda activate` 和环境变量在同一终端标签内持续有效。
- `top`、Python REPL 和交互式安装确认可以正常使用。
- 调整浏览器窗口后远端终端尺寸同步变化。

### 阶段 4：SFTP 文件能力

优先级：P1  
目标：支持项目浏览、上传、下载和安全编辑。

功能范围：

- 浏览目录和读取文件元数据。
- 上传、下载、新建目录、重命名和删除。
- 文本文件查看和有条件写入。
- Agent 使用结构化文件 API，不通过 shell 拼接路径。
- 默认根目录为远端 `$HOME`，额外根目录需要用户明确授权。
- 持续禁止 `.ssh`、私钥、凭据、`.env*` 和其他敏感路径。
- 写入使用临时文件、校验大小和原子替换。

验收标准：

- 不能通过 `..`、符号链接或编码变体逃离授权根目录。
- 大文件使用流式传输，不整体载入 Bridge 内存。
- 上传中断不会覆盖已有目标文件。

### 阶段 5：仪表盘增强

优先级：P2  
目标：从单次快照升级为可操作的服务器监控视图。

新增指标：

- CPU 核心数、整体与分核心利用率。
- 内存、Swap 和缓存使用。
- 所有磁盘挂载点和 inode 使用率。
- 网络收发速率。
- GPU 利用率、显存、温度、功耗和 GPU 进程列表。
- 训练进程 PID、用户、运行时间和命令摘要。

展示方式：

- 默认五秒刷新，可暂停。
- 保留最近 30 分钟的内存历史，用折线图显示。
- 状态采集失败时单独标记指标，不让整个仪表盘失效。
- 移动端使用单列布局，避免图表和文字重叠。

### 阶段 6：持久化和长期任务

优先级：P1（下一阶段核心里程碑）  
目标：Bridge 重启后仍能识别历史任务，并可靠管理训练任务。

详细设计见 [`PERSISTENT_TASK_PLAN.md`](PERSISTENT_TASK_PLAN.md)。默认采用无安装方案，将 SSH Connection、Persistent Task 和 Observer 拆分；远端常驻 Runner 仅保留为未来可选增强。

实现要求：

- 使用 SQLite 保存非敏感任务元数据和审计记录，并按 owner、状态和更新时间建立分页索引。
- 不保存 SSH 密码、Agent token、私钥或完整敏感输出。
- 普通 SSH channel 任务明确标记为随 Bridge 生命周期结束。
- 长训练通过 `tmux`、Slurm 或 `systemd-run` 启动，记录远端任务标识。
- Bridge 重启后重新发现远端持久任务及日志路径。
- 远端记录按 SSH 用户和日期分区，活动任务使用独立小型索引，禁止全历史递归扫描。
- 日志、事件缓存和历史摘要设置分片、保留期、容量配额和 LRU 清理策略。
- 任务目录从创建起固定不移动；活动索引只保存指针和摘要，终态只移除活动标记。
- 日志使用单调递增游标并返回已清理边界，轮转后观察器可以准确续读。
- 无远端常驻程序时使用机会式清理；本机离线期间依靠单任务硬上限控制磁盘。
- 启动器能力探测包含可选登出存活测试，未验证的后台化只能标记为尽力模式。
- 远端 manifest、启动器状态和进程身份是恢复事实，本地 SQLite 仅作为索引缓存。
- 有界日志包装器和版本化任务清单必须先完成独立原型与压力验证，作为完整 Task API 的开工门槛。
- 已完成 setsid/nohup 远端原型、exec channel 分离、有界日志和日志写入失败降级验证；完整 SSH 登出、其他启动器及 DDP 进程组取消仍是启用门槛。
- 当前验证主机仅提供 `systemd-run --user`，且用户 `Linger=no`；transient unit 运行中可恢复、完成后会被 systemd 237 回收，因此 manifest 是历史事实来源，完整登出前可靠性只能标记为尽力模式。
- Bridge SSH 会话断开与新会话重连恢复已经实测通过；由于同一远端用户仍有其他登录会话，`Linger=no` 条件下最后登录退出的存活能力仍不得标记为已验证。
- 双卡 torchrun/DDP 取消已实测通过：2 个 rank、4 个 DataLoader worker 和 GPU 占用全部清理；取消后仍必须执行残留核对，异常时标记 `cancel_incomplete`。
- wrapper 监督进程与训练子 PGID 已分离，日志低流量短读已验证；当前可进入 feature flag 默认关闭的 Task API 批次，启动器按能力逐项启用。
- feature flag 下的 Agent Task API 已完成真实远端验收：创建、活动发现、重启后按 ID 恢复、offset 日志、setsid 取消、systemd 自然完成和远端 UTC 一致性均通过；reconcile、本地 SQLite 索引、日志续读、存储保护和网页任务中心已在后续批次完成。
- 按持久任务核心、日志与存储、网页任务中心三个批次实施并分别验收。
- 取消操作必须覆盖整个进程组或调度器任务；torchrun/DDP 取消后不得残留 GPU 或 DataLoader worker。
- 完整测试矩阵覆盖本机断联、服务重启、远端重启、PID 复用、记录损坏、多观察器和配额耗尽。
- 自动清理只作用于 Bridge 管理数据，绝不自动删除 checkpoint、权重、数据集或用户输出目录。

## 5. 测试策略

### 单元测试

- 状态机转换和非法转换。
- 终端槽位分配、复用和上限。
- 输出环形缓冲与 UTF-8 边界。
- capability token 权限、过期和撤销。
- 路径规范化和符号链接逃逸。

### 集成测试

- 使用本地 OpenSSH 测试容器覆盖密码和密钥认证。
- 覆盖 OpenSSH 7.6 与较新版本的兼容行为。
- 模拟连接中断、认证延迟、超时和大输出。
- 验证 Paramiko 与 AsyncSSH 两种后端。

### 浏览器测试

- 桌面与移动视口下的仪表盘布局。
- 多终端标签创建、切换、忙碌和取消状态。
- SSE 断线重连和历史输出恢复。
- Agent 授权请求、批准、撤销和过期提示。

## 6. 第一轮实施清单

第一轮只实施阶段 1，避免同时引入 PTY、SFTP 和授权协议重构。

预计修改：

- `bridge.py`：任务状态机、运行句柄、取消、超时、SSE 和全局并发限制。
- `assets/app.js`：事件订阅、实时输出、停止按钮和任务状态显示。
- `assets/index.html`：终端任务控制区域。
- `assets/app.css`：运行、失败、取消和超时状态样式。
- `tests/test_bridge.py`：状态机、取消、超时、并发上限和 SSE 测试。
- `README.md`：新接口和行为说明。

第一轮完成定义：

- 所有现有测试通过。
- 新增取消、超时、SSE 和并发上限测试。
- 页面可实时显示输出并停止任务。
- Agent 可提交、监听和取消任务。
- 密码不进入任何新增对象、响应、日志或持久化数据。
- 沙箱外 Bridge 重启后完成一次真实 SSH 并发、流式输出和取消回归。

## 7. 暂不实施

以下内容不进入第一轮：

- 通用 HTTP/SOCKS 网络代理。
- 自动接受 SSH 主机指纹。
- 将 SSH 密码写入文件、环境变量或浏览器存储。
- 无上限终端、任务、输出或上传。
- Agent 直接控制用户 PTY。
- 默认允许访问远端敏感目录。

## 8. 回退策略

- 每个阶段保持现有 REST 接口兼容，新增字段使用向后兼容默认值。
- SSE 不可用时，页面继续使用任务状态轮询。
- PTY 上线后保留结构化模拟终端作为 Agent 和故障回退路径。
- 新授权协议上线前保留旧开关，但在页面明确标为兼容模式，验证完成后再移除。
- 每次重启 Bridge 前先运行单元测试、Python 编译和前端语法检查。
