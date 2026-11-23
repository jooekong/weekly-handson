# Agent Sandbox（W3）

- 周次：W3 · 2026.11.16 – 11.22（2026-11-23 补做）
- 状态：已交付，待验收
- 计划：[plan.md](plan.md)
- 交付：[docs/DELIVERY.md](docs/DELIVERY.md)

## 环境基线

- 执行端：`ubuntu-e2b`（Tailscale `100.111.51.1`），自托管 E2B Embed `93d747e8`，orchestrator v0.30，Firecracker v1.17，guest kernel 6.1.177
- 客户端：Mac，Node v23.10.0，`e2b@2.62.0`
- 模板 `base`：2 vCPU / 512 MiB

## 实验进度

最终证据在 [logs/2026-11-23T03-54-45-790Z-all](logs/2026-11-23T03-54-45-790Z-all/)：

- [x] CSV 聚合结果与手算、awk 一致 → `csv.json`
- [x] 命令超时由 envd 杀进程 → `cmd-timeout.json`
- [x] 沙箱超时由 orchestrator 销毁 VM → `sbx-timeout.json`
- [x] 网络 allow/deny 对照，以及收紧后复测 → `network.json`
- [x] kill 后 API 和宿主机都无残留 → `destroy.json`、`summary.json`
- [x] 手动交互场景（找密钥、域名白名单、内存炸弹）→ DELIVERY「手动交互验证」
- [ ] DELIVERY §10 用自己的话写结论

## 怎么跑

```sh
npm install
node run.mjs all        # or: csv | cmd-timeout | sbx-timeout | network | destroy
```

需要 `ssh e2b` 能登录；API key 运行时读取，不落盘。

## 核心概念

- **执行端隔离**：边界是 Firecracker VM，不是 guest 里的 Linux 用户权限（`user` 有免密 sudo）。
- **网络限制在宿主侧执行**：slot netns 里的 nft，加上 iptables 把 TCP REDIRECT 到 orchestrator egress 代理；guest 内的 root 改不了。
- **两层超时**：命令级（envd，在 VM 内）和沙箱级（orchestrator，在宿主机）。客户端的 `TimeoutError` 只是现象。
- **生命周期**：create → run → kill / timeout → 宿主机 firecracker 进程消失、network map 被移除。

## 验收重点

- 应用约定和执行端强制要分开：guest 内文件权限属于前者，宿主机网络规则和 VM 销毁属于后者。
- 一次拒绝只证明一条策略下的一类流量，见 DELIVERY §6。

## 成果

- 一句话收获：
- 还没搞懂：
