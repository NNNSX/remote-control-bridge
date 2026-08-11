# Node SSH Remote Control Skill 设计方案

## 1. 目的

构建一个可被 Codex/Agent 使用的跨平台远程服务器管理 skill：

- 在 Windows、Linux、macOS 本地运行；
- 通过 SSH 管理校园网或其他受信任服务器；
- 提供网页登录、服务器状态仪表盘、命令执行、多终端并行、实时输出和任务取消；
- 为 Agent 提供结构化命令接口；
- 将授权、SSH 会话和网页 API 分离，允许 API 服务重启而不丢 SSH 会话；
- 不保存 SSH 密码，不提供通用 HTTP/SOCKS 代理。

## 2. 技术选型

核心运行时：Node.js 20+。

主要组件：

- `ssh2`：SSH、exec、PTY、SFTP 和端口转发；
- Node `http`：loopback API；
- `ws`：真实 WebSocket PTY；
- `zod`：请求和配置校验；
- SQLite：非敏感任务元数据和审计记录；
- 原生 `ssh`：兼容性回退和诊断，不作为默认密码自动化通道。

## 3. 服务架构

```text
Codex Skill / Browser
          |
     bridge-api
          |
   capability check
          |
     sessiond
          |
       ssh2
          |
    Remote SSH Host
```

### bridge-control

只管理授权：

- capability grant、scope、过期和撤销；
- 主机、端口、用户名和可信 SSH 指纹绑定；
- 通过本机 Named Pipe 或 loopback 接口提供内部调用；
- 不执行 SSH 命令，不接触远程文件。

### sessiond

只管理远程会话：

- 保存 SSH 连接、PTY、exec channel、SFTP channel；
- 每会话最多 4 个终端，全局最多 8 个活动任务；
- 提供命令队列、实时输出、取消、超时和任务状态；
- 重启 bridge-api 时保持 SSH 会话继续运行；
- 密码只存在于创建连接的调用栈，不进入任务对象或持久化数据。

### bridge-api

负责浏览器和 Agent：

- 网页登录和主机指纹确认；
- 仪表盘、终端标签页和 SSE/WebSocket；
- 校验 capability 后转发到 sessiond；
- 不直接保存 SSH client 对象。

### 文件管理工作台

文件操作使用 SFTP 结构化 API，不通过 shell 拼接路径：

- 目录树浏览、面包屑导航和文件搜索；
- 文件类型、大小、修改时间、权限和所有者展示；
- 文本文件预览，支持 UTF-8、GBK/Latin-1 检测和大文件截断提示；
- 文本编辑器，显示未保存状态、冲突提示和保存前差异；
- 上传、下载、断点进度、重命名、新建目录和删除；
- 图片、JSON、YAML、CSV、日志和 Markdown 的专用预览；
- Agent 使用结构化文件 API，不允许直接提交任意远程路径。

默认文件根目录为远程用户 `$HOME`。`.ssh`、私钥、凭据、`.env` 和密钥文件默认隐藏或只读；删除、覆盖、批量操作和离开 `$HOME` 必须二次确认。大文件采用流式传输，不整体载入 Bridge 内存。

## 4. Skill 使用方式

安装后的目录示例：

```text
node-remote-ssh/
├── SKILL.md
├── package.json
├── bin/
│   ├── bridge-api.js
│   ├── sessiond.js
│   └── bridge-control.js
├── assets/
└── scripts/
```

Codex 使用流程：

1. Skill 检查 Node.js 和依赖；
2. 启动 `bridge-control`、`sessiond`、`bridge-api`；
3. 用户打开本机网页并输入主机、端口、用户名；
4. 首次连接显示 SSH 指纹，用户确认后才信任；
5. 推荐使用 SSH 公钥认证；密码仅用于临时登录或安装公钥；
6. 用户明确开启 Agent 授权；
7. Codex 通过 Agent API 提交结构化命令；
8. 命令通过 SSE/WebSocket 返回实时输出和最终状态。

## 5. 主要接口

```text
POST   /api/v1/sessions
POST   /api/v1/host-keys/trust
GET    /api/v1/sessions/<id>/status
POST   /api/v1/sessions/<id>/commands
GET    /api/v1/sessions/<id>/jobs/<id>
GET    /api/v1/sessions/<id>/jobs/<id>/events
DELETE /api/v1/sessions/<id>/jobs/<id>
GET    /api/v1/agent/session
POST   /api/v1/agent/commands
DELETE /api/v1/agent/jobs/<id>

GET    /api/v1/sessions/<id>/files?path=.
GET    /api/v1/sessions/<id>/files/preview?path=relative/path
GET    /api/v1/sessions/<id>/files/download?path=relative/path
POST   /api/v1/sessions/<id>/files/upload
PUT    /api/v1/sessions/<id>/files/content
POST   /api/v1/sessions/<id>/files/mkdir
POST   /api/v1/sessions/<id>/files/rename
DELETE /api/v1/sessions/<id>/files
```

## 6. 安全边界

- 所有本地服务只监听 `127.0.0.1` 或 Named Pipe；
- SSH 指纹必须显式确认，不自动接受；
- 密码不写入日志、配置、SQLite、任务对象或环境变量；
- capability 必须绑定目标主机指纹并带 scope 和过期时间；
- 默认禁止访问 `.ssh`、私钥、凭据、`.env` 等敏感路径；
- 不实现通用 SOCKS/HTTP 代理；
- 命令、输出、并发终端和超时均有上限；
- 文件路径只能是规范化的相对 POSIX 路径，禁止 `..`、符号链接逃逸和敏感目录；
- 文件上传、覆盖、删除和批量变更必须显式确认，并记录操作类型、目标和结果；
- sessiond 密钥由本机用户权限保护，不能暴露到局域网。

## 7. 预期结果

完成后，用户可以：

- 在本机网页登录远程服务器并查看 GPU、磁盘、负载和运行时间；
- 同时运行多个远程命令，每个命令拥有独立终端槽位；
- 实时查看 stdout/stderr，随时取消任务；
- 让 Codex/Agent 通过结构化接口管理远程任务；
- 在文件管理器中浏览项目、预览日志和配置、编辑代码并上传下载数据；
- 对训练配置、日志和结果文件执行可追踪的安全修改；
- 单独重启网页/API 服务而不丢 SSH 会话；
- 在 Windows、Linux、macOS 上使用同一套 skill 协议。

## 8. 验收标准

- OpenSSH 7.6 和新版本服务器均可使用公钥认证；
- 断开并重启 bridge-api 后，sessiond 中的 SSH 会话和任务仍可查询；
- 未授权 Agent 无法发现会话或提交命令；
- 撤销 capability 后下一次请求立即失败；
- 文件预览不会把完整大文件载入内存，覆盖和删除操作可被取消或拒绝；
- 4 个会话终端和 8 个全局任务上限生效；
- 所有单元测试、跨平台启动测试和浏览器端到端测试通过。
