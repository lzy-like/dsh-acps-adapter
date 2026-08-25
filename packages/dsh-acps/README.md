# dsh-acps — DSH ↔ ACPs Leader 桥接插件

让 DeepSeek Harness (DSH) 成为一个 **ACPs Leader**：发现 ACPs Partner 智能体、读取其能力描述（ACS）、把每个技能注册为 DSH 原生工具（`acps__<partnerId>__<skillId>`），并通过 AIP 协议（直连模式 RPC：start → poll → complete）委托任务、聚合结果。

## 协议基础（ACPs）

- **ACS**（Agent Capability Specification，智能体能力描述）：Partner 的能力清单，`skills[]` 中的每一项 = 一个可调用技能。
- **AIP**（Agent Interaction Protocol，智能体交互协议）：Leader ↔ Partner 的交互协议。直连模式走 JSON-RPC 2.0，`POST /rpc` 发送 `TaskCommand`（start/get/continue/complete/cancel），Partner 返回 `TaskResult`（状态机：accepted → working → awaiting-input / awaiting-completion → completed/canceled/failed/rejected）。
- **ADP**（Agent Discovery Protocol，智能体发现协议）：`POST {server}/discover` 查询可用智能体（可选集成）。

## 插件结构

```
lib/index.js    Cordis 插件入口（Config 校验 + apply）
lib/aip.js      AIP RPC 客户端（纯 JS 实现）+ 委托生命周期（delegateTask）
lib/sdk-bridge.js  AipRpcClient 兼容实现：经 Python 桥接进程调用官方 acps-sdk
lib/acs.js      ACS 加载（acs / acsFile / acsUrl）与规范化
lib/adp.js      ADP 发现客户端
lib/tools.js    技能 → DSH ToolDefinition 桥接 + 发现工具
bridge/acps_bridge.py   Python 桥接进程（使用官方 acps_sdk.aip.aip_rpc_client）
cordis.patch.yml  bundle patch：插入 acps 插件行 + Leader persona
```

## 两种 AIP 传输

| transport | 说明 | 依赖 |
|---|---|---|
| `js`（默认） | 插件内置的 JS 客户端（`lib/aip.js`），按 AIP 规范直连 `/rpc` | 无 |
| `sdk` | 插件 spawn `bridge/acps_bridge.py`，**真正使用官方 acps-sdk** 的 `AipRpcClient` 完成 AIP 通信（经 localhost TCP JSON-RPC） | Python ≥3.10 + `pip install acps-sdk` |

`sdk` 模式配置：

```yaml
- id: acps
  config:
    transport: sdk                    # 默认传输（partner 可单独覆盖）
    python:
      command: python                 # Python 解释器
      pythonPath: D:\path\to\pylibs   # 指向包含 acps_sdk 的目录（PYTHONPATH）
      port: 0                         # 桥接 TCP 端口，0 = 随机
```

安装 SDK（示例，装到工作区 `.pylibs` 避免污染系统环境）：

```powershell
python -m pip install --target .pylibs acps-sdk
```

## 配置

在 profile 的 `cordis.patch.yml` 中配置（会整体替换 bundle 里的默认配置）：

```yaml
- id: acps
  config:
    leader:
      aic: dsh-leader-001
      name: DSH ACPs Leader
    defaults:
      pollIntervalMs: 2000        # 轮询间隔
      pollTimeoutMs: 300000       # 单次委托总超时
      completeOnAwaitingCompletion: true
      requestTimeoutMs: 30000     # 单次 RPC 请求超时
    discovery:
      serverBaseUrl: ''           # ADP 发现服务（可选），配置后注册 acps_discover 工具
      limit: 10
    partners:
      - id: beijing-food          # 命名空间，决定工具名前缀
        name: 北京美食推荐智能体
        url: http://127.0.0.1:9021/rpc      # AIP RPC 端点
        acsUrl: http://127.0.0.1:9021/acs   # ACS 来源（也可用 acsFile / acs 内联）
        # aic: 1.2.156.3088.1.1.xxx
        # headers: { Authorization: 'Bearer xxx' }
```

## 工具命名

每个技能注册为 `acps__<partnerId>__<skillId>`（如 `acps__beijing-food__beijing_catering.traditional-food-recommendation`），符合 DeepSeek 函数名约束（≤64 字符、`[A-Za-z0-9_-]`，损失性归一化时附加确定性哈希后缀）。

## 委托行为

- 工具入参：`request`（自然语言任务描述）。
- 执行：`start` 发送请求 → 轮询 `get` 直到收敛：
  - `awaiting-input`：返回 Partner 的提问（`needsInput: true, inputQuestion`），由 Leader 模型补充信息后再次调用；
  - `awaiting-completion`：自动发送 `complete`，返回产出物；
  - 终态（completed/canceled/failed/rejected）：返回状态与产出物。
- 支持 `exec.signal` 取消与总超时（超时自动 `cancel` 防止 Partner 空转）。
