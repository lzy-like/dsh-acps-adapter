# Contributing

感谢你考虑为 dsh-acps 贡献代码！

## 环境准备

```bash
git clone <your-fork-url>
cd dsh-acps
npm install -g pnpm   # 可选：发布/安装插件时使用
python -m pip install --target .pylibs acps-sdk   # 可选：SDK 桥接测试需要
```

## 本地验证

```bash
# 1) 启动本地 mock 生态（无需任何外部服务）
node mock-partner/server.js 9021 &
node mock-discovery/server.js 9050 &

# 2) 协议级冒烟测试
node scripts/smoke-aip.js 9021      # JS 客户端 + ADP
node scripts/smoke-bridge.js        # 官方 acps-sdk 桥接（需 .pylibs）

# 3) 端到端（可选，需要 DSH 与 DeepSeek Key）
dsh --profile acps-headless "推荐一套今天的穿搭（上海，INFP，心情平静）"
```

## 代码约定

- 插件为纯 ESM（`type: module`），Node ≥ 22。
- 新文件同步加入 `packages/dsh-acps/package.json` 的 `files`。
- 修改 `lib/` 后必须通过 `node --check`；修改 `bridge/acps_bridge.py` 后通过 `python -m py_compile`。
- 配置项必须带 schemastery 校验与默认值，且**禁止硬编码机器路径**（用环境变量）。
- 提交信息：`feat/fix/docs/refactor/test: 简短描述`。

## PR 流程

1. Fork + 分支（`feat/xxx`、`fix/xxx`）。
2. 本地跑通 `scripts/smoke-aip.js` 与 `scripts/smoke-bridge.js`。
3. 提交 PR，描述改动与验证结果；CI 会自动跑协议冒烟。

## 协议合规

- ACPs 协议规范（GB/Z 185 参考实现）文本只**引用**，不随本仓库分发；参考仓库见
  [AIP-PUB/ACPs-community](https://github.com/AIP-PUB/ACPs-community)（MulanPSL-2.0）。
- 演示数据（mock partner 的 ACS/文案）如参考官方 demo-partner，请在注释中标注来源。
