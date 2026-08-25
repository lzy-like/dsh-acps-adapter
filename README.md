# dsh-acps-adapter — 用 DSH 搭建 ACPs Leader

把 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 变成 [ACPs](https://github.com/AIP-PUB/ACPs-community)（Agent Collaboration Protocols，智能体协作协议体系，GB/Z 185《人工智能 智能体互联》参考实现）的 **Leader 智能体**：通过 DSH 插件把 ACPs Partner 智能体的技能注册为 DSH 原生工具，让 DSH 模型直接委托、调用并聚合多个 ACPs 智能体。

## 架构

```
┌─────────────────────────── DSH (Leader) ───────────────────────────┐
│  dsh --profile acps  (web GUI, 端口 3090)                          │
│  dsh --profile acps-headless (CLI/脚本)                            │
│                                                                   │
│   ┌──────────────────────────────────────────────────────────┐    │
│   │  dsh-acps 插件 (profile bundle)                          │    │
│   │  · 读取每个 Partner 的 ACS（能力描述）                   │    │
│   │  · 每个技能 → DSH 工具 acps__<partner>__<skill>          │    │
│   │  · 工具执行 → AIP RPC 委托 (start→poll→complete)         │    │
│   │    ├─ transport: sdk → 官方 acps-sdk（Python 桥接）      │    │
│   │    └─ transport: js  → 内置 JS 客户端                    │    │
│   │  · 可选 ADP 发现服务 (acps_discover 工具 + 自动注册)     │    │
│   └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────┬────────────────────────────────────┘
                               │ AIP (JSON-RPC 2.0, POST /rpc)
              ┌────────────────┼─────────────────┐
              ▼                ▼                 ▼
       beijing-food     beijing-urban      china-transport ...
       (mock 9021)      (mock 9022)          (mock 9025)
       └── 真实 ACPs Partner 也可接入（同协议）
```

## 目录

```
packages/dsh-acps/         DSH 插件（AIP/ACS/ADP 客户端 + 工具桥接）
mock-partner/              本地 ACPs Partner 模拟器（AIP RPC 协议，端口 9021–9025）
mock-discovery/            本地 ADP 发现服务模拟器（端口 9050）
profiles/acps/             web profile 源（bundles + cordis.patch.yml）
profiles/acps-headless/    headless profile 源（CLI 验证用）
scripts/deploy-profile.ps1 部署到 $DSH_HOME
scripts/smoke-aip.js       协议级冒烟测试（AIP RPC + ADP 发现，不依赖 DSH）
acps-community/            ACPs 官方仓库参考克隆
```

## 仓库结构（大白话版）

> 比喻：插件 = 让 DSH 学会说 ACPs 话的翻译器；智能体 = 门店；Leader = 调度中心。

```
dsh-acps-adapter/
├── README.md                 ← 说明书（怎么装、怎么用、怎么接智能体）
├── LICENSE                   ← 使用许可（MIT：别人可以自由使用、修改）
├── .gitignore                ← 上传黑名单（Python 依赖、密钥、会话记录都挡在外面）
├── .gitattributes            ← 换行符规范（防止不同电脑间文件变乱）
├── .env.example              ← 参数示例（告诉别人该设置哪些环境变量）
├── CONTRIBUTING.md           ← 贡献指南（别人想改代码，按这个流程来）
├── SECURITY.md               ← 安全问题怎么私下报告
├── .github/workflows/ci.yml  ← 自动测试（每次提交代码自动跑一遍检查）
│
├── packages/dsh-acps/        ← ★ 核心：翻译器插件
│   ├── lib/                  ←    插件代码（注册工具、AIP 对话客户端、
│   │                               官方 SDK 桥接、穿搭 Leader 桥接）
│   ├── bridge/acps_bridge.py ←    Python 小桥（让插件真的用官方 acps-sdk）
│   ├── cordis.patch.yml      ←    插件"安装说明书"（装什么、Leader 人设写哪）
│   ├── package.json          ←    插件身份证（名字、版本、依赖什么）
│   └── README.md             ←    插件自己的说明
│
├── profiles/                 ← 两个"调度中心"的配置
│   ├── acps/                 ←    网页版 Leader（端口 3090）
│   └── acps-headless/        ←    命令行版 Leader
│
├── mock-partner/             ← 5 个"练习门店"（假的 ACPs 智能体）
│   ├── server.js             ←    假门店服务（按 ACPs 规矩回话）
│   └── partners/*/acs.json   ←    每个假门店的"介绍信"
│
├── mock-discovery/           ← 1 个"练习问询处"（假发现服务）
│
└── scripts/                  ← 辅助工具
    ├── deploy-profile.ps1    ←    一键部署（把插件装进 DSH）
    └── smoke-*.js            ←    自动测试（协议、SDK 桥接、穿搭桥接）
```

## 快速开始

### 0. 前置

- Node.js ≥ 22（已装 v24）、PowerShell
- DSH（`dsh` 命令在 PATH 上）
- Python ≥ 3.10：默认 AIP 传输使用**官方 acps-sdk**（经 `bridge/acps_bridge.py` 桥接）；安装 SDK：
  ```powershell
  python -m pip install --target .pylibs acps-sdk
  ```
  （若只想用插件内置的 JS 客户端，可把 profile 配置里的 `transport: sdk` 改为 `transport: js`，无需 Python。）

### 1. 启动 mock ACPs Partner（5 个智能体）与 ADP 发现服务

```powershell
cd mock-partner
node generate-partners.mjs   # 首次生成 partner 配置（可选）
node server.js 9021          # 5 个 partner，端口与各自 ACS 声明一致（9021–9025）

cd ..\mock-discovery
node server.js 9050          # ADP 发现服务：返回全部 5 个智能体供 Leader 自动注册
```

### 2. 部署插件与 profile 到 DSH

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-profile.ps1
```

### 3. 端到端验证（headless）

```powershell
dsh --profile acps-headless "我想在北京品尝最正宗的烤鸭，请委托合适的智能体帮我推荐几家老字号餐厅"
```

### 4. 启动 Web Leader（新端口，不影响现有 3080 GUI）

```powershell
dsh --profile acps --port 3090
# 浏览器打开 http://127.0.0.1:3090 ，与 Leader 对话
```

## 测试

```powershell
# 协议级冒烟测试（需先启动 mock partner）
node scripts/smoke-aip.js 9021
```

## 接入真实 ACPs Partner

1. 在 `profiles/acps/cordis.patch.yml` 的 `partners` 中增加条目：`url` 填 Partner 的 `/rpc` 端点，`acsUrl` 填其 ACS 地址（或 `acsFile` 指向本地 ACS JSON）。
2. 若 Partner 走 mTLS/令牌，用 `headers` 配置（如 `Authorization`）。
3. 若有 ADP 发现服务，配置 `discovery.serverBaseUrl`：
   - Leader 启动时**自动注册**发现服务返回的智能体（按 AIC/端点去重，静态配置的智能体不会被重复注册）；
   - 同时获得 `acps_discover` 工具，可在运行时查询生态。
4. 重新执行 `deploy-profile.ps1` 后重启对应 profile。

## 接入真实 ACPs 生态（ioa.pub）

当前 `acps` / `acps-headless` profile 直接对接**官方 ACPs 生态**：

- **发现**：`discovery.serverBaseUrl: https://ioa.pub/discovery/acps-adp-v2`（官方 ADP，公开可用）——启动时自动注册生态返回的智能体，并注册 `acps_discover` 工具。
- **直连智能体**：无需客户端证书即可调用的 Partner 直接走 AIP（如 `Wit-Weather`：`https://www.ioa.pub/api/searcher/aip`）。
- **mTLS 网关智能体**：官方生态多数 Partner 的 `/rpc` 要求 ACPs CA 签发的客户端证书（ACPs 信任模型），未持有证书时调用会失败——这类智能体可通过其 **Leader 的公开协作接口**接入：
  ```yaml
  webLeaders:
    - id: clothes-leader
      name: 穿搭推荐 Leader
      url: https://clothes.renew.cc.cd/api/chat   # 该 Leader 内部用 AIP 调用「穿搭推荐智能体」
      description: 穿搭推荐：输入城市、MBTI、心情，生成个性化穿搭方案
  ```
  注册后 DSH leader 获得 `acps__clothes-leader__web-coordination` 工具，实测可返回真实穿搭方案（含天气匹配）。

## 端到端验证记录

| 场景 | 命令/方式 | 结果 |
|---|---|---|
| 协议冒烟（AIP RPC + ADP） | `node scripts/smoke-aip.js 9021` | ✅ 全部通过 |
| **acps-sdk 桥接冒烟** | `node scripts/smoke-bridge.js` | ✅ 官方 SDK 全生命周期 |
| 单智能体委托（**SDK 传输**） | headless：推荐老字号烤鸭 | ✅ 返回全聚德等推荐 |
| 澄清流程（awaiting-input） | headless：模糊请求"随便推荐" | ✅ Leader 补充信息后完成 |
| ADP 自动注册 | 静态仅配 2 个，Leader 调用了城区/酒店智能体 | ✅ 发现注册生效 |
| `acps_discover` 运行时查询 | headless：要求列出可用智能体 | ✅ 返回 5 智能体 19 技能 |
| 多智能体聚合（**SDK 传输 + 发现**） | headless：2日游（城区+美食+酒店） | ✅ 汇总为完整行程 |
| **官方生态发现（ioa.pub ADP）** | headless：列出可用智能体 | ✅ 返回官方注册的真实智能体 |
| **穿搭智能体（真实）** | headless：上海/INFP/平静，推荐穿搭 | ✅ 返回真实穿搭方案（桥接穿搭推荐 Leader → 穿搭推荐智能体） |

## 说明

- 当前实现覆盖 **AIP 直连模式（RPC Style）**；群组模式（消息队列）与流式模式（SSE）不在本适配器范围内。
- `mock-partner` 是协议级模拟（完整生命周期 + 澄清流程），用于本地验证；真实部署请替换为 ACPs 官方 demo-partner（`acps-community/demo-partner`，Python）。
- 本仓库是对 DSH 插件机制的扩展，不改动 DSH 本体。

## 开源与发布

- **许可证**：本仓库代码与文档采用 **MIT**（见 `LICENSE`）。`acps-community` 是外部参考仓库（MulanPSL-2.0），**不随本仓库分发**，请自行克隆；官方 SDK 通过 `pip install acps-sdk` 按需安装。
- **仓库卫生**：`.pylibs`（pip 产物）、DSH 会话、`.env`、凭据均已被 `.gitignore` 排除；配置中的机器路径已替换为环境变量（见 `.env.example`）。
- **CI**：`.github/workflows/ci.yml` 自动跑协议冒烟（AIP/ADP/SDK 桥接/Web Leader 桥接，全部本地 hermetic）；DSH 端到端为手动触发（需 `DEEPSEEK_API_KEY` secret）。
- **发布为 npm 包**（让用户一条命令安装）：
  ```bash
  cd packages/dsh-acps
  npm publish            # 发布 dsh-acps
  # 使用者：
  dsh plugin --profile acps add dsh-acps   # 安装进 profile（需 pnpm）
  ```
  发布前把 `package.json` 的 `repository.url` 换成真实仓库地址。
- **贡献**：见 `CONTRIBUTING.md`；安全问题见 `SECURITY.md`。
