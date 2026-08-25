# Security Policy

## 报告漏洞

请**不要**在公开 issue 中提交安全漏洞。通过以下方式私下报告：

- 仓库维护者的邮箱（待发布时补充）
- 或 GitHub Security Advisory（"Report a vulnerability"）

## 安全说明

- 本插件会向配置的 ACPs Partner `/rpc` 端点发送任务内容；请只对接你信任的智能体。
- `transport: sdk` 会启动 Python 桥接进程并监听本地 TCP 端口（默认随机）；请勿将
  DSH 所在机器暴露给不可信网络（DSH web 默认绑定 127.0.0.1）。
- mock-partner / mock-discovery 仅用于本地开发，**不要**部署到公网。
- 环境变量（`ACPS_SDK_PYTHONPATH`、`DEEPSEEK_API_KEY`）与 DSH 凭据文件
  （`$DSH_HOME/.credentials.yaml`）不得提交到仓库。
