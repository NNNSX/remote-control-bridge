# Remote SSH Skill 最终版改造方案

## 1. 产品定位

这是一个跨 Windows、Linux、macOS 的通用远程 SSH 交互与文件工作台，主要服务于远程开发、运维、实验室服务器和深度学习服务器。

深度学习能力是增强模块，不是系统前提。核心目标是：

- SSH 会话稳定、持续、可恢复；
- 网页终端、Agent 和文件管理共享同一远程会话；
- API/网页服务重启不影响远程任务；
- 操作可观察、可取消、可审计；
- 默认不泄露密码，不开放通用网络代理。

## 2. 最终技术栈

- Node.js 20+：统一运行时；
- `ssh2`：SSH、exec、PTY、SFTP；
- `ws`：WebSocket PTY；
- `zod`：请求和配置校验；
- SQLite：非敏感任务元数据、审计和历史；
- 原生 OpenSSH：诊断和兼容回退；
- 原有 HTML/CSS/JavaScript 前端：逐步复用，不强制引入大型前端框架。

## 3. 服务拆分

```text
Codex Skill / Browser
          |
     bridge-api
          |
  capability verification
          |
       sessiond
          |
        ssh2
          |
    Remote SSH Host
```

### bridge-control

只负责授权和本地身份：

- capability grant、scope、过期和撤销；
- 主机、端口、用户名、SSH 指纹绑定；
- 本地 Named Pipe 或 loopback 内部接口；
- 不保存 SSH 密码，不执行远程命令。

### sessiond

只负责远程会话生命周期：

- SSH 连接、PTY、exec channel 和 SFTP channel；
- 会话、终端槽位、任务队列和实时事件；
- 断线重连、取消、超时、输出环形缓冲；
- 任务持久化和 tmux/Slurm 可选适配器；
- 不提供浏览器页面，不处理用户界面。

### bridge-api

负责网页和 Agent API：

- 会话创建、指纹确认和状态仪表盘；
- REST、SSE、WebSocket PTY；
- capability 检查和请求转发；
- 文件管理界面和审计展示；
- 不直接持有 SSH client。

## 4. 功能范围

### 会话和终端

- 密钥认证优先，密码仅用于临时连接或公钥安装；
- 真实 WebSocket PTY；
- 多终端标签页，每会话最多 4 个；
- Ctrl+C、方向键、Tab、终端尺寸同步；
- 浏览器刷新和 bridge-api 重启后可继续使用已有 sessiond 会话。

### 任务执行

- 结构化命令提交；
- queued/running/completed/failed/cancelled/timed_out 状态；
- stdout/stderr 实时事件；
- 超时、取消、退出码和运行时长；
- sessiond 重启前后区分短任务和持久任务；
- 持久任务使用 tmux、Slurm 或 systemd-run。

### 文件工作台

- SFTP 目录树、搜索、排序和面包屑；
- 文本、日志、JSON、YAML、CSV、Markdown 预览；
- 在线编辑、diff、冲突检测、原子保存；
- 上传、下载、断点续传、新建目录、重命名、删除；
- 大文件流式传输；
- 默认根目录为 `$HOME`，敏感路径隐藏或只读。

### 监控工作台

- 主机名、在线时间、负载、CPU、内存、Swap、磁盘、网络；
- 进程列表、用户、PID、命令摘要和资源占用；
- GPU 利用率、显存、温度和进程作为可选指标；
- 自动刷新、暂停、历史趋势、阈值告警；
- 任务、日志、进程和 GPU 之间可以互相跳转。

### Agent 能力

- status:read；
- jobs:read；
- jobs:execute；
- jobs:cancel；
- files:read；
- files:write；
- 每次操作都验证 capability、scope、目标会话和过期时间；
- 文件写入、删除和联网操作默认需要额外确认。

## 5. 安全边界

- 所有本地服务只绑定 `127.0.0.1` 或 Named Pipe；
- SSH 指纹必须显式确认，不自动接受；
- 密码不写入文件、日志、环境变量、任务对象或数据库；
- 不提供通用 SOCKS/HTTP 代理；
- 若需要本地联网，只实现明确命令、域名、端口的受控 egress；
- 禁止 `..`、符号链接逃逸和敏感目录访问；
- 上传、覆盖、删除、批量变更和远程联网必须二次确认；
- 审计只保存时间、操作类型、目标、结果和错误摘要，不保存密码和完整敏感输出。

## 6. 改造顺序

### 阶段 0：基线冻结

- 保留现有 Python Bridge 作为协议参考；
- 固定 REST/SSE 路径和任务状态；
- 保存当前 40 项测试和真实服务器回归记录；
- 当前旧服务已停止，避免改造期间端口和状态混用。

### 阶段 1：Node sessiond

- 实现 SSH 密钥、密码和 keyboard-interactive；
- 实现 exec、PTY、SFTP；
- 复刻当前内部 `/internal/v1` API；
- 完成 OpenSSH 7.6、较新 OpenSSH 和断线测试。

### 阶段 2：Node bridge-control

- 复刻 capability grant、绑定、过期和撤销；
- 使用平台安全存储或受限文件权限保存签名密钥；
- 完成撤销即时生效和重启恢复测试。

### 阶段 3：Node bridge-api

- 代理现有页面/API；
- 接入 SSE 和 WebSocket PTY；
- 接入新的文件管理器和监控工作台；
- 保持前端请求协议向后兼容。

### 阶段 4：Skill 打包

- 编写 `SKILL.md`；
- 提供 Windows、Linux、macOS 启动器；
- 自动选择平台和架构二进制；
- 提供 start/stop/status/doctor；
- 失败时输出明确诊断，不输出密码和私钥。

## 7. 预期使用方式

```text
安装 skill
启动本地服务
打开 http://127.0.0.1:<port>/
输入 SSH 连接信息
确认主机指纹
查看仪表盘、终端和文件
按需开启 Agent capability
```

Codex 通过结构化 API 执行命令、读取状态、查看文件和订阅任务事件；用户仍可以在网页中打开真实终端并进行交互。

## 8. 最终验收

- Windows、Linux、macOS 均能启动；
- OpenSSH 7.6 和新版本服务器均能使用公钥认证；
- bridge-api 重启不会断开 sessiond 中的 SSH 会话；
- PTY、SFTP、命令任务、SSE 和 WebSocket 均有自动化测试；
- 文件覆盖、删除、敏感路径和 capability 越权测试全部通过；
- 长任务可通过 tmux/Slurm 继续运行；
- 连续运行 24 小时无内存泄漏、终端槽位泄漏或任务状态卡死。
