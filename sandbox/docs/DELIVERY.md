# W3 交付：Agent Sandbox 受限代码执行

- 日期：2026-11-23
- 运行时：自托管 E2B（Embed 单节点 docker compose）· Firecracker microVM
- 执行端：`ubuntu-e2b`（Ubuntu 24.04.5，x86-64 KVM 虚拟机，宿主内核 6.8.0-149）
- 客户端：Mac（Apple Silicon）经 Tailscale 访问，Node v23.10.0，`e2b@2.62.0`
- 最终证据：[`logs/2026-11-23T03-54-45-790Z-all/`](../logs/2026-11-23T03-54-45-790Z-all/)（5/5 PASS，无残留）

## 1. 版本基线

来自 [`run.json`](../logs/2026-11-23T03-54-45-790Z-all/run.json)：

| 组件 | 版本 |
|---|---|
| E2B Embed 源码 | `/opt/e2b/SOURCE_COMMIT` = `93d747e8967dc83e9cd56dff2e8105c880bb3af6` |
| orchestrator | `v0.30.202611112209-a4981d7dc00` |
| Firecracker | `v1.17-0.4.1` |
| guest kernel | `vmlinux-6.1.177_5008931` |
| 模板 | `base`（2 vCPU / 512 MiB，guest 内 `free` 看到 473 MiB，rootfs 2.6G，Python 3.11.6，envd 0.10.0）|
| SDK | `e2b@2.62.0`（与服务端 `node-e2b` 镜像内版本一致）|
| 节点上限 | `MAX_SANDBOXES_PER_NODE=4` |

复现：`cd sandbox && npm install && node run.mjs all`（需要 `ssh e2b` 可用；API key 运行时经 ssh 读取，不落盘）。

## 2. 关键决定

**运行时与 Apple Silicon**：E2B 的执行端是 Firecracker，需要 Linux + `/dev/kvm`，macOS 原生不满足（官方 Embed compose README 要求 Linux x86-64/arm64 + KVM）。所以 Mac 只做客户端（SDK → API `:3000` / client-proxy `:3002`），执行端放在 Linux KVM 主机上。没有在 Mac 上用普通子进程冒充沙箱。

**实际策略**：

| 维度 | 允许 | 证据 |
|---|---|---|
| 文件 | 只通过 SDK `files.write/read` 进出沙箱，写到 `/home/user`；宿主机文件系统不挂载进 guest | csv 用例 |
| 网络（policy 用例）| `denyOut: ["0.0.0.0/0"]` + `allowOut: ["1.1.1.1"]` | network.policy |
| 网络（收紧后）| `denyOut: ["0.0.0.0/0"]`，`allowOut: []` | network.tightened |
| 网络（平台固定）| 私网段 `10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16` 一律拒绝（无论策略）| network.baseline.privateProbes + hostRules |
| 凭据 | 沙箱内不注入任何 key；E2B API key 只在 Mac 进程内存里 | `env.mjs` |
| 时间 | 命令级 `timeoutMs: 5000`；沙箱级 `timeoutMs: 30000` + `onTimeout: kill` | cmd-timeout / sbx-timeout |
| 资源 | 模板固定 2 vCPU / 512 MiB | csv.env |

## 3. 测试输入与预期（实现前冻结）

- [`data/orders.csv`](../data/orders.csv)：20 行合成订单。
- [`expected.json`](../expected.json)：手算的分组结果（east 5/310、north 6/350、south 5/300、west 4/305、合计 20/1265），以及网络/超时预期。运行时另用 awk 独立复算（`csv.json → awkCrossCheck`），与手算一致。
- [`scripts/loop.py`](../scripts/loop.py)：死循环，自己不会退出。
- 网络对照：A=`1.1.1.1`（允许），B=`1.0.0.1`（禁止）。同一服务的两个 IP，基线下都能访问，用来证明「被拒」不是因为目标不可达。

## 4. 验收结果

| # | 验收条件 | 结果 | 原始证据 |
|---|---|---|---|
| 1 | 正常处理 CSV，输出与独立答案一致 | **已验证** | [csv.json](../logs/2026-11-23T03-54-45-790Z-all/csv.json)：`out` 与 `expected.aggregate` 深度相等，awk 复算一致 |
| 2a | 命令超时被执行端终止 | **已验证** | [cmd-timeout.json](../logs/2026-11-23T03-54-45-790Z-all/cmd-timeout.json)：执行中 `ps` 看到 `python3 loop_cmd.py`（CPU 98.1%）→ 5006 ms 抛 `TimeoutError` → 2 s 后 `ps` 已没有该进程，loadavg 0.07 |
| 2b | 沙箱超时由宿主侧销毁整个 VM | **已验证** | [sbx-timeout.json](../logs/2026-11-23T03-54-45-790Z-all/sbx-timeout.json)：guest 内后台死循环仍在跑，客户端**不调用 kill**；`t≈32.4s`（轮询间隔约 5 s）API 列表和宿主机 firecracker 进程都消失；orchestrator 日志 `marking sandbox as stopping` → `sandbox lifecycle stopped`；`Sandbox.connect` 返回 `SandboxNotFoundError` |
| 3 | 禁止访问被执行端拒绝，且有允许对照 | **已验证** | [network.json](../logs/2026-11-23T03-54-45-790Z-all/network.json)：baseline A/B 都是 `301`；policy A `301`、B `000 curl_exit=52`；宿主机该 slot（`ns-3` / `e2b-3`）里 `filtered_denylist={0.0.0.0/0}`、`filtered_allowlist={1.1.1.1}`，iptables 把 `e2b-3` 的全部 TCP REDIRECT 到 orchestrator 的 egress 代理（`:5016/:5017/:5018`）|
| 复测 | 收紧一个允许项后复测 | **已验证** | 同上 `tightened`：去掉 `1.1.1.1` 后 A、B 都是 `000 curl_exit=52` |
| 4 | 销毁后无残留 | **已验证** | [destroy.json](../logs/2026-11-23T03-54-45-790Z-all/destroy.json)：kill 前 API 列出 + 宿主机 firecracker 1 个（guest 内死循环在跑）→ `kill()` 后 0.4 s 内两者都消失，5 s 后复查仍为 0；orchestrator 日志 `lifecycle stopped` + `network map entry removed`。[summary.json](../logs/2026-11-23T03-54-45-790Z-all/summary.json) 全部用例跑完后 `apiSandboxes: []`、`hostFirecracker: []` |

### 附加观察（不是验收项）

- **沙箱访问不到宿主机和内网**：即使不加任何网络策略，guest 访问宿主机局域网 IP `192.168.1.201:3000` 和 Tailscale IP `100.111.51.1:3000` 都是 `curl_exit=28`（超时被丢包），对应 slot netns 里的 `filtered_always_denylist`。
- **guest 内文件权限不是边界**：root 建的 `700` 目录，`user` 直接 `cat` 得到 `Permission denied`，但 `sudo -n cat` 能读出来——`base` 模板的 `user` 在 sudo 组且免密。guest 内的 Linux 权限只是应用层约定；真正的隔离边界是 VM，以及宿主侧的网络和生命周期控制。

### 手动交互验证（2026-11-23 下午，Joe 在 Node REPL 中执行）

场景：Agent 执行「被注入的分析代码」。沙箱策略为 `denyOut: ["0.0.0.0/0"]` + `allowOut: ["pypi.org", "files.pythonhosted.org"]`。这部分没有自动落盘，下表是从终端输出摘录的。

| 步骤 | 输出 | 结论 |
|---|---|---|
| 1 上传 CSV 并计算 | `20 1265` | 与 `expected.json` 的 total 一致 |
| 2a 找密钥：`env`、`ls ~` | 只有 `E2B_SANDBOX*`、`E2B_EVENTS_ADDRESS=http://192.0.2.1` 和普通登录变量，**没有 `E2B_API_KEY`**；`/home/user` 里只有默认 dotfile 和 `orders.csv` | 「不注入密钥」靠的是调用方约定（SDK 只在显式传 `envs` 时才注入），不是沙箱技术在拦 |
| 2b POST 到 `example.com` | `000 exit=52` | 白名单外的域名被 egress 代理断开 |
| 2b 对照 GET `pypi.org/simple/` | `200 exit=28` | 白名单内的域名可以访问。`28` 是因为全量索引太大，5 s 内没下载完，不是被拦 |
| 3 内存炸弹 | Joe 确认「验证通过」 | **没有存档原始输出**（被杀时的 MB 数、dmesg 记录、firecracker RSS 峰值都没记录），所以只算口头确认，不算已验证证据 |
| 过程中 | 两台沙箱分别在 14:51:47、15:01:58 按 `timeoutMs` 到期被回收（orchestrator 日志） | 现场复现了验收 2b：`timeoutMs` 是从创建开始计算的绝对寿命，不是空闲超时 |

还没做：伪造 Host/SNI 绕过域名白名单的测试（未执行）。

## 5. 执行链（本次数据实际经过的路径）

```
Mac run.mjs ──Tailscale──> api :3000 (Sandbox.create, network/lifecycle 写进 sandbox 配置)
                          └─> orchestrator :5008 → Firecracker VM（slot ns-N，tap0）
Mac run.mjs ──> client-proxy :3002 ──> guest envd :49983（commands.run / files.*，命令超时由 envd 执行）
guest 出站：tap0 → ns-N nft slot-firewall（私网段 drop；非 TCP 按 allow/deny set）
           → 宿主 e2b-N → iptables REDIRECT 所有 TCP → orchestrator egress 代理（按 allowOut/denyOut 放行或断开）
超时：orchestrator 按 sandbox timeout 发起 stop → 杀 Firecracker 进程、释放 NBD/overlay、移除网络 map
```

「谁来强制执行」对应关系：

- 命令超时：guest 内的 envd 杀进程。是在 VM 里执行的，但不依赖脚本自觉退出。
- 沙箱超时和销毁：宿主机上的 orchestrator，直接结束 Firecracker 进程。
- 网络：宿主机侧的 nft + iptables + egress 代理。guest 内的 root 也改不了这些规则。
- SDK 的 `TimeoutError` 只是客户端看到的现象；判定依据是 `ps`、`pgrep firecracker` 和 orchestrator 日志。

## 6. 未验证的限制（不能承诺）

- CPU 配额是否硬限制（没有做 fork bomb）、磁盘写满时的表现。
- 非 TCP 出站：UDP/ICMP 在规则上走 nft set，本次只看到 `filtered_denylist` 计数器有 2 个包，没有专门构造 UDP/ICMP 用例。DNS 外泄、IPv6 出站都未测。
- 域名型 `allowOut`：手动验证中正反对照都成立（见上），但**伪造 Host 或 SNI 能否绕过**没有测。这个结果决定了域名白名单能不能信。
- `192.0.2.1`：平台通道，在 `filtered_always_allowlist` 里，`denyOut: 0.0.0.0/0` 也挡不住；服务器把它的 80/111/2049 端口转发到 orchestrator 的内部服务（:5010/:5012/:5011）。暴露了什么、有没有鉴权，都未验证。
- 内存上限：只有口头确认，没有原始证据（见上）。
- `allowPublicTraffic: true`（默认值）：沙箱端口可以不带 token 从 client-proxy 访问，本次没有收紧。
- 沙箱逃逸、内核/Firecracker 漏洞：按非目标处理，未尝试。
- 多租户并发（同节点多个沙箱互访）未测。

**为什么一次禁止访问成功不足以证明整个沙箱安全**：它只证明了「这条策略下、这个 TCP 目标 IP 会被宿主侧拒绝」。其他协议（UDP/ICMP/IPv6）、其他通道（DNS、client-proxy 入站、envd API 本身）、资源耗尽、内核层面的逃逸都是独立的边界，各自需要单独的反例测试。而且安全性取决于宿主机配置（例如 always_denylist），换一个部署就要重新验证。

## 7. 费用、停止、回滚、清理

- 费用：自托管，不产生 E2B 云计费，也没有调用模型。官方云版按运行秒计费（vCPU 和内存分别计价，kill/pause 后不计费），见下方资料。
- 停止条件：网络或超时如果没有在执行端生效，直接记为 FAIL，不换实现。本次没有触发。
- 清理：每个用例都在 `finally` 里调用 `kill()`（sbx-timeout 故意例外，靠执行端回收），runner 结束时检查 API 和宿主机都为空（见 `summary.leftover`）。
- 回滚：没有改动服务器上的 E2B 配置和 compose，只执行了只读的 `docker logs`、`pgrep`、`iptables -S`、`nft list`。

## 8. 过程偏差

- 第一轮 [`03-52-04-733Z`](../logs/2026-11-23T03-52-04-733Z-all/) 也是 5/5 PASS，但 `cmd-timeout` 的判定有缺陷：`pgrep -af loop_cmd.py || echo NO_PROCESS` 会匹配到它自己所在的 bash 命令行，而那行里正好有 `NO_PROCESS` 字样，结论是碰巧对的；`network.hostRules` 读的是写死的 ns-1，不是该沙箱实际所在的 slot。修复：改用 `ps | grep '[p]ython3 …'`，并加上「执行期间进程确实在跑」的正向对照；slot 改为通过 firecracker pid 和 `ip netns identify` 反查。第二轮为最终证据。
- 原方案的备选「在宿主机上起测试 HTTP 端口作为对照」不可行：宿主机局域网 IP 和 Tailscale IP 在 always_denylist 里，guest 本来就访问不到。

## 9. 资料核验

- E2B Docs · [Internet access](https://e2b.dev/docs/sandbox/internet-access)：`allowOut`/`denyOut`、allow 优先于 deny、deny 不支持域名、`allowInternetAccess:false` 等价于 deny `0.0.0.0/0`。
- E2B Docs · [Sandbox lifecycle](https://e2b.dev/docs/sandbox) / [How long does a sandbox live?](https://docs.e2b.dev/faq/sandbox-lifetime)：默认超时 5 分钟，超时动作默认 kill，`kill()` 立即结束。
- E2B Docs · [How do I calculate the price of a sandbox?](https://docs.e2b.dev/faq/calculate-sandbox-price)：按运行秒计费，按分配的 vCPU/内存计价。
- e2b-dev/runtime · [embed/compose/README.md](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md)：Embed 需要 Linux（x86-64/arm64）+ KVM + `/dev/net/tun`，推荐 Ubuntu 24.04。
- e2b-dev/infra · [self-host.md](https://github.com/e2b-dev/infra/blob/main/self-host.md)：Firecracker 需要裸金属或嵌套虚拟化。
- 本地 SDK 类型定义 `node_modules/e2b/dist/index.d.ts`（2.62.0）：`SandboxNetworkConfig`、`SandboxLifecycle.onTimeout`、`CommandStartOpts.timeoutMs`（默认 60 s）。

## 10. 我的结论

> 由 Claude 按 Joe 的要求起草，Joe 确认后提交。

我接受这个方案，因为隔离发生在执行端而不是应用层：代码跑在 Firecracker microVM 里，网络限制由宿主机侧的 netns nft 和 egress 代理执行，生命周期由 orchestrator 直接结束 VM 进程。VM 里的代码（包括有免密 sudo 的 `user`）改不了这几层。Mac 只当客户端，Linux KVM 主机当执行端，这也回答了 Apple Silicon 的适配问题，不需要用普通子进程冒充沙箱。

关键证据是：
- 同一个目标 IP，不加策略时能访问、加策略后被拒，而且宿主机该 slot 的 `filtered_denylist` / `filtered_allowlist` 与下发的策略一致；
- 死循环在执行中可见（CPU 98%），超时后进程消失；
- 客户端不调用 kill，沙箱到期后服务器上的 firecracker 进程和 API 记录同时消失，orchestrator 日志里有完整的停止记录；
- 全部用例跑完后，API 和宿主机上都是 0 残留。

目前不能承诺：
- UDP/ICMP/IPv6/DNS 出站是否也被限制；
- 伪造 Host 或 SNI 能否绕过域名白名单；
- `192.0.2.1` 平台通道暴露了什么；
- CPU 和磁盘配额是否硬限制，内存上限也缺原始证据；
- 沙箱逃逸。

一次拒绝成功只证明了「这条策略下、这类 TCP 流量」被拦住，不代表整个沙箱安全。

失败时我会：如果策略或超时没在执行端生效，把对应用例记为 FAIL，停止让不受信任的代码在这个环境里运行，而不是放宽验收标准；按 `Sandbox.list()` 和宿主机 `pgrep firecracker` 找出残留并逐个 kill。上线前要先补上述未验证项的反例测试，再扩大使用范围。
