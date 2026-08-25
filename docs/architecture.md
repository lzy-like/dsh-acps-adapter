# dsh-acps — ACPs Leader 架构图

## 1. 整体架构（谁在哪、怎么连）

```
┌────────────────────────────── 用户 ──────────────────────────────┐
│  ① 浏览器 → http://127.0.0.1:3090（Web Leader GUI）               │
│  ② 命令行 → dsh --profile acps-headless "任务"                   │
└───────────────────────────────┬──────────────────────────────────┘
                                │ 自然语言
                                ▼
╔══════════════════ DSH（DeepSeek Harness）— 扮演 ACPs Leader ══════════════════╗
║  profile: acps / acps-headless（$DSH_HOME/profiles/<name>）                  ║
║  bundles 层：dsh-base → dsh-web-app(或 dsh-headless) → dsh-acps             ║
║  cordis.patch.yml：Leader 人设 + 官方发现 + 穿搭 Leader 桥接配置             ║
║                                                                              ║
║   ┌───────────────────────── dsh-acps 插件（Cordis）────────────────────┐   ║
║   │  lib/index.js     插件入口：Config 校验 + 启动时注册                 │   ║
║   │   ├─ partners[]   → 读 ACS → 每个技能注册为工具                     │   ║
║   │   ├─ discovery    → acps_discover 工具 + 自动注册生态智能体         │   ║
║   │   └─ webLeaders[] → Web Leader 桥接工具                             │   ║
║   │                                                                      │   ║
║   │  lib/tools.js   技能 → DSH 工具  acps__<partner>__<skill>           │   ║
║   │  lib/aip.js     AIP RPC 客户端（JS/fetch）+ 委托生命周期            │   ║
║   │  lib/sdk-bridge.js  SdkBridgeClient ──TCP──▶ Python 桥接进程        │   ║
║   │  lib/web-leader.js  WebLeaderClient ──POST /api/chat──▶ 外部 Leader ║   ║
║   │  lib/acs.js     ACS 加载（acs 内联 / acsFile / acsUrl）             │   ║
║   │  lib/adp.js     ADP 发现客户端                                      │   ║
║   │  bridge/acps_bridge.py  Python 桥接（官方 acps_sdk.aip）            │   ║
║   └──────────────────────────────┬──────────────────────────────────────┘   ║
║                                  │ ctx.tools.register(ToolDefinition)       ║
║   DSH agent loop：模型 + Leader persona（system-prompt）                     ║
║   · 决策调用哪个智能体 · 处理 awaiting-input 追问 · 聚合多智能体结果          ║
╚══════════════════════════════════╤═══════════════════════════════════════════╝
                                   │ AIP (JSON-RPC 2.0) / HTTP
              ┌────────────────────┼──────────────────────┬────────────────────┐
              ▼                    ▼                      ▼                    ▼
     官方发现服务（ADP）     直连智能体             mTLS 网关智能体        本地 mock 生态
     ioa.pub                Wit-Weather          穿搭推荐 Leader          mock-partner
     /discovery/            www.ioa.pub/api/      clothes.renew.cc.cd     9021–9025
     acps-adp-v2            searcher/aip          /api/chat               mock-discovery 9050
              │                    │                     │  (内部 AIP)          │
              ▼                    ▼                     ▼                      ▼
     自动注册到工具池       acps__wit-weather__*   穿搭推荐智能体         离线开发/CI 验证
     （返回 acsMap）        （真实调用成功 ✅）     partner-api.renew.     （协议冒烟）
                                                   cc.cd/rpc（mTLS 证书） 
```

## 2. 插件内部模块与一次委托的数据流

```
模型调用工具 acps__beijing-food__traditional-food-recommendation
        │  args = { request: "推荐北京烤鸭老字号" }
        ▼
lib/tools.js  createSkillTool().execute
        │
        ▼
lib/aip.js  delegateTask()        ←── 委托生命周期（AIP 状态机）
        │  start ──▶ 轮询 get（每 2s）──▶ 终态/awaiting-completion ──▶ complete
        ▼
   ┌── 传输层（按 partner.transport 选择）──────────────────────┐
   │  js   → lib/aip.js  AipRpcClient（fetch，零依赖）          │
   │  sdk  → lib/sdk-bridge.js → TCP JSON-RPC                  │
   │         → bridge/acps_bridge.py → 官方 acps-sdk           │
   │  web  → lib/web-leader.js → POST 外部 Leader /api/chat    │
   └──────────────────────────┬────────────────────────────────┘
                              ▼
                     Partner /rpc 端点（AIP）
                              │
                              ▼
                   TaskResult → products[]（文本/文件/结构化）
                              │
                              ▼
             返回 { state, products, needsInput?, … }
             模型聚合 → 最终答复给用户
```

## 3. 目录结构（仓库视角）

```
dsh-acps-adapter/
├── packages/dsh-acps/          ← 插件（可发布 npm：dsh-acps）
│   ├── lib/                    ← index / aip / sdk-bridge / web-leader / acs / adp / tools
│   ├── bridge/acps_bridge.py   ← 官方 SDK Python 桥接
│   └── cordis.patch.yml        ← bundle 补丁：插件行 + Leader persona
├── profiles/acps/              ← Web Leader profile（bundles + 配置）
├── profiles/acps-headless/     ← CLI Leader profile
├── mock-partner/               ← 本地 mock ACPs 智能体（9021–9025，离线开发）
├── mock-discovery/             ← 本地 ADP 发现服务（9050，离线开发）
├── scripts/                    ← 部署脚本 + 冒烟测试
├── .github/workflows/ci.yml    ← CI（hermetic 冒烟 + 可选 E2E）
└── docs/architecture.md        ← 本文件
```

## 4. 关键配置（profile cordis.patch.yml）

```yaml
- id: acps
  config:
    leader:      { aic: dsh-leader-001, name: DSH ACPs Leader }
    transport:   js                        # 或 sdk（官方 acps-sdk 桥接）
    discovery:   { serverBaseUrl: https://ioa.pub/discovery/acps-adp-v2, ... }
    webLeaders:  [{ id: clothes-leader, url: https://clothes.renew.cc.cd/api/chat, ... }]
    partners:    []                        # 或静态配置 { id, url, acsUrl }
```
