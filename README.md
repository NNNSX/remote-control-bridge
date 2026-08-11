# Remote Control Bridge

Remote Control Bridge 是一个只监听本机回环地址的 SSH 管理 skill。它提供浏览器工作台和 Agent 接口，用于临时连接远程服务器、执行受限命令、查看日志、管理任务，以及通过 SFTP 浏览和传输文件。

它不会保存 SSH 密码，不会监听公网端口，也不会在远程服务器安装常驻程序。

## 快速开始

推荐使用 Node.js 版本，要求 Node.js 20 或更高版本。

```powershell
cd remote-control-bridge
$SkillRoot = (Resolve-Path ".").Path
cd "$SkillRoot\node"
npm ci
cd $SkillRoot

powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillRoot\manage-services-node.ps1" Start All
powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillRoot\manage-services-node.ps1" Status All
```

然后在本机浏览器打开：`http://127.0.0.1:8877/`

停止服务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillRoot\manage-services-node.ps1" Stop All
```

服务默认端口：

| 服务 | 端口 | 作用 |
| --- | ---: | --- |
| Bridge | 8877 | 浏览器 API 和前端 |
| Control | 8878 | Agent 授权控制 |
| Session | 8879 | SSH 会话、终端和任务 |

三个服务都运行在宿主机上。请从普通的宿主机 PowerShell 启动，不要从受限的 Codex 沙箱启动 SSH 服务。

## 连接远程服务器

在网页中填写远程主机、端口、用户名和认证方式。支持：

- 临时密码认证
- Ed25519 私钥认证
- 首次连接时确认 SSH SHA-256 主机指纹

密码只用于 SSH 握手，不写入配置、日志或磁盘。保存的连接配置只包含主机、端口、用户名和认证方式。

连接成功后，网页提供以下标签：

- **概览**：会话状态和主机信息
- **终端**：受限的异步命令执行和实时输出
- **任务**：查看、跟踪、取消和固定后台任务
- **文件**：SFTP 文件浏览、上传、下载、重命名、删除空目录或文件，以及安全预览
- **日志**：读取指定的远程日志

## Agent 接口

连接后，在网页中明确打开“允许本地 Agent”。授权后，回环 Agent 才能发现当前会话并调用接口。

常用接口：

```text
GET  /api/v1/agent/session
POST /api/v1/agent/commands
GET  /api/v1/agent/jobs/<job-id>
GET  /api/v1/agent/jobs/<job-id>/events
DELETE /api/v1/agent/jobs/<job-id>
GET  /api/v1/agent/files?path=.
GET  /api/v1/agent/files/preview?path=<relative-path>
GET  /api/v1/agent/files/download?path=<relative-path>
POST /api/v1/agent/logs
```

命令接口返回 `job_id`，调用方可以轮询状态或订阅 SSE 输出。命令有超时、输出大小和并行终端数量限制。

Agent 默认只有：

- 读取会话和状态
- 执行受限命令
- 读取文件、预览文件、下载文件
- 读取指定日志

Agent 默认不能上传、写入、重命名或删除文件。需要用户确认的文件操作仍由网页完成。

## 持久任务（实验功能）

需要长时间运行或允许浏览器暂时断开时，可以显式启用持久任务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillRoot\manage-services-node.ps1" Restart All -EnablePersistentTasks
```

任务创建后立即返回 `task_id`，不会因为浏览器关闭、SSH 观察连接断开或 Agent 观察超时而自动取消。之后可以通过网页“任务”标签或 Agent 接口按任务 ID 查看状态和日志。

删除 Bridge 自己的任务记录是单独的默认关闭功能：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillRoot\manage-services-node.ps1" Restart All -EnablePersistentTasks -EnableRemoteTaskDeletion
```

任务记录只保存执行元数据、状态和受限日志。Bridge 不理解训练、模型、数据集或 checkpoint 等领域概念，也不会自动删除或恢复用户文件。

## 文件与预览

文件标签使用 SFTP，并跟随当前打开的远程目录。上传和下载都在文件管理中完成，支持可暂停、可取消的传输任务。

为避免浏览器或服务被异常二进制内容拖垮：

- 图片使用图片预览
- 文本预览有大小上限
- `pt`、权重、压缩包等二进制文件默认不预览
- 大文件只提供元数据、下载或传输操作
- `.ssh`、`.env`、云凭据、私钥等敏感路径会被拦截

## 配置

可选配置文件用于保存经过允许列表控制的连接、日志或制品路径。不要把密码、私钥、Token、任意下载 URL 或代理变量写入配置。

```text
python bridge.py --port 8877
python bridge.py --config PATH --port 8877
```

上面的 Python 入口保留用于兼容旧部署；新部署优先使用 Node.js 服务管理脚本。

## 重启范围

- 只改前端 `assets/`：刷新浏览器即可
- 修改 `node/sessiond.mjs`：重启 Session，会断开当前 SSH 会话
- 修改 `node/bridge-api.mjs`：重启 Bridge
- 修改 `node/bridge-control.mjs`：重启 Control

Windows 下可以单独重启：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-services-node.ps1 Restart Bridge
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-services-node.ps1 Restart Session
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-services-node.ps1 Restart Control
```

如果网页提示 `connect EACCES <host>:22`，通常是服务从受限网络环境启动。请从普通宿主机 PowerShell 停止并重新启动服务；这不是 SSH 密码错误。

## 安全边界

- HTTP 服务只绑定 `127.0.0.1`
- 外部 `Host` 和 `Origin` 请求会被拒绝
- SSH 会话需要用户主动连接和确认主机指纹
- 命令、输出、文件预览和传输都有大小或时间限制
- 故障测试使用本地 FakeRemote、临时目录和隔离服务，不会重启或修改真实远程环境
- Bridge 不替代远程账号权限控制；高安全场景仍应使用受限远程账号或管理员网关

## 测试

```powershell
python -m unittest discover -s tests -v
python -m compileall -q .
cd node
npm test
```

更多设计和迁移记录：

- [`SKILL.md`](SKILL.md)：Codex skill 使用说明
- [`NODE_SSH_SKILL_DESIGN.md`](NODE_SSH_SKILL_DESIGN.md)：Node.js 架构设计
- [`PERSISTENT_TASK_PLAN.md`](PERSISTENT_TASK_PLAN.md)：持久任务设计
- [`FINAL_REFACTOR_PLAN.md`](FINAL_REFACTOR_PLAN.md)：重构记录
- [`UI_QA_CHECKLIST.md`](UI_QA_CHECKLIST.md)：界面验收清单
