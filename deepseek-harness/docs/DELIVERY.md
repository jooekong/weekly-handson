# W1 交付记录：只读模拟订单助手

2026-11-04。当前状态：验收 1–3 项真实模型端到端通过（CPA / gpt-6-luna）；第 4 项（Joe 亲手改 fixture 后新会话复测）待执行。

## 规格与版本

规格为 [W01 v3 任务卡](../ai-delivery-learning-v3/W01-harness.md)，无需先完成旧版 TODO 练习。接续 Claude session `ac397937-4c71-4139-990c-d3dd21177145`；Joe 最后确认“走预构建，版本按你推荐的来。node现在没安装吗”。沿用 overlay 加本地插件、独立 fixture、headless 新会话验收方案，不构建 Harness 源码。

| 项目 | 实际值 |
| --- | --- |
| dsh | npm `@deepseek-ai/dsh@0.2.1-rc.5` |
| 官方 tag / commit | `dsh-v0.2.1-rc.5` / `b830ec950faba0a46dda564be3e2d854afed94f1` |
| 源码只读克隆 | `/Users/joe/code/deepseek-harness`；checkout 仍为 `8bd073392eef6f54e921a093b95076248eb08cbb`，本次用 `git show <tag>:<file>` 核对固定版本 |
| npm 安装目录 | `/Users/joe/code/dsh-w1` |
| npm 依赖锁 | [runtime-record/package-lock.json](../w1-order/runtime-record/package-lock.json)，与 Node 24 `npm ci` 后的运行时锁文件逐字节一致 |
| 实验 Node / npm | brew keg-only `node@24` `v24.22.2` / `11.19.1`（`/opt/homebrew/opt/node@24/bin`，仅 PATH 前缀使用） |
| 全局 Node | `v23.10.0`，未改动；低于 24.9，不用于运行 Harness |
| App 自带 Node | `v24.21.0`，hardened runtime + Team ID 签名，拒绝加载 ad-hoc 签名的 npm 原生模块，不再使用 |
| 实验 DSH_HOME | `/Users/joe/code/dsh-w1-home`，不复用 GUI 的 `~/.dsh` |
| 工作目录 | `/Users/joe/code/dsh-w1-workspace`，独立空目录 |
| 测试模型 | Joe 自建 CLIProxyAPI（CPA）网关，OpenAI 协议（`llm-pi-ai` 路由 `w1-cpa`，`api: openai-completions`），模型 `gpt-6-luna`（CPA 后端走 Codex 订阅）。偏离任务卡默认的 DeepSeek，由 Joe 指定。base URL 含秘密路径前缀，与 key 一起只存于 `$DSH_HOME/.env`（600 权限），不入库 |

官方 [README](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/README.md) 支持 npm 启动。本次没有安装 pnpm、编译 Harness 或修改上游文件。

## 实现与冻结预期

[orders.json](../w1-order/orders.json) 与 [cases.json](../w1-order/cases.json) 根据任务卡手工固定，预期不从实现输出生成。

| 用例 | 输入 | 固定预期 |
| --- | --- | --- |
| 01-paid | O1001 | paid，12900 分，CNY；回答应为 129.00 CNY |
| 02-missing | O404 | found:false；成功调用，不编造状态、金额或原因 |
| 03-error | 测试模式 OERR | 工具抛 SIMULATED_TIMEOUT；查询失败，不表示订单不存在 |
| 04-refunded | 仅把 fixture 的 O1001 状态改成 refunded，新会话查询 | refunded，金额币种不变；插件代码不变，数据 hash 改变 |

[order-plugin.ts](../w1-order/order-plugin.ts) 用 `defineTool` 注册 `get_order`，每次调用重新读取文件，并返回文件原始字节 SHA-256 的前 12 位 `dataVersion`。文件 JSON、字段、金额及订单 ID 在边界校验；读取或校验失败直接抛出，不降级成查无数据。OERR 仅在 `testMode:true` 时立即抛出受控故障；这不是真实网络超时实验。

审计写 stderr，包含 callId、订单 ID、数据版本、耗时、成功/失败及错误，保持 headless JSON stdout 可解析。参数校验失败或策略拒绝未进入插件 execute，因此不会出现在这份工具体审计中。

[w1.patch.yml](../w1-order/w1.patch.yml) 采用 native 工具模式，关闭内置工具插件、会话日志上传、遥测、额外标题生成请求和 LLM 重试。禁用 ID 已与固定版本核对，配置组合已通过；运行时工具集合仍需从实际 `request/header` 核验为仅有 get_order。

## 已执行验证与证据

### 直接工具执行：通过

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' w1-order/run.mjs local
```

退出码 0。原始 [stdout](../w1-order/logs/2026-11-04T07-48-06-807Z-local/local.stdout.log)、[审计 stderr](../w1-order/logs/2026-11-04T07-48-06-807Z-local/local.stderr.log)、[命令和版本](../w1-order/logs/2026-11-04T07-48-06-807Z-local/local.run.json)。四个用例通过；同一工具实例能读取新 fixture。另验证了测试模式关闭、错误参数、损坏 JSON 和非法金额。

使用真实 defineTool 和输出 schema 校验，注册上下文为最小桩；没有经过 Agent Loop、策略流水线、会话持久化或模型，不能算端到端验收。

### 配置组合：通过

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' w1-order/run.mjs config
```

退出码 0。原始 [组合配置](../w1-order/logs/2026-11-04T07-45-44-023Z-config/config.stdout.log)、[命令和版本](../w1-order/logs/2026-11-04T07-45-44-023Z-config/config.run.json)。dump-config 不执行插件或调用模型。

### Node 24 重新安装与真实启动探测：通过（到缺凭据为止）

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm ci --prefix ~/code/dsh-w1 --no-audit --no-fund   # 616 packages, exit 0
node w1-order/run.mjs local    # exit 0
node w1-order/run.mjs config   # exit 0
node w1-order/run.mjs probe    # 子进程 exit 1，符合预期
```

npm 11 默认未执行 koffi、node-pty、subprocess-local 等 5 个包的安装脚本（未加入 allowScripts）；本次探测不受影响，未放开脚本权限。

probe 证据：[stdout](../w1-order/logs/2026-11-04T09-24-51-209Z-probe/probe.stdout.log)、[stderr](../w1-order/logs/2026-11-04T09-24-51-209Z-probe/probe.stderr.log)、[会话日志](../w1-order/logs/2026-11-04T09-24-51-209Z-probe/probe.session.jsonl)。插件加载、会话创建、turn/step 启动均完成；持久化 `request/header` 的工具列表为 `["get_order"]`（运行时工具集合核验通过）；`turn/end` 原因为 `MISSING_CREDENTIAL`，没有模型请求发出。

### 无 key 的真实启动探测（App 自带 Node）：环境失败（历史记录）

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' w1-order/run.mjs probe
```

探测脚本及子进程均退出 1。原始 [stderr](../w1-order/logs/2026-11-04T07-52-17-274Z-probe/probe.stderr.log)、[stdout](../w1-order/logs/2026-11-04T07-52-17-274Z-probe/probe.stdout.log)、[运行信息](../w1-order/logs/2026-11-04T07-52-17-274Z-probe/probe.run.json)。

失败发生于 dsh-app-boot 的 host preparation：`node-addon-require-builtin-darwin-arm64` 没有可加载的原生模块。尚未创建会话或加载订单插件，没有模型请求。probe 显式把 DEEPSEEK_API_KEY 设为空，遮蔽 `.env` 回退。

根因交叉核对：首次正常 npm install 的 koffi 安装脚本失败；随后只为诊断执行 `npm install --ignore-scripts` 展开依赖，再直接加载 koffi，macOS 报 `mapping process and mapped file ... have different Team IDs`。App 签名的 Node 不接受 npm 外部原生模块，安装器才转向源码构建并报缺少 CMake。没有添加 CMake、修改签名或降低安全设置。ignore-scripts 的诊断展开不能算正常安装成功，须在获批的独立 Node 24 下重新正常安装。

### 四项端到端验收

命令：`PATH=/opt/homebrew/opt/node@24/bin:$PATH node w1-order/run.mjs case <id>`，每项新进程、新会话。机器检查：`request/header` 工具集合仅 `get_order`、恰好 1 次 `tool/call`、callId 在 `tool/call` / `tool/result` / 审计行三方一致、`dataVersion` 等于 fixture sha256 前 12 位（`fe75bb4eaae0`）、`isError` 符合预期。

| 条件 | 直接工具层 | 真实模型（gpt-6-luna） | 最终回答原文（人工语义核对） | 证据 |
| --- | --- | --- | --- | --- |
| O1001 | 通过 | 通过，2 个 Step，`turn/end` completed | 「订单 O1001 状态：已支付；金额：129.00 元人民币（CNY）。」✅ | [logs](../w1-order/logs/2026-11-04T09-49-51-529Z-case/) |
| O404 | 通过 | 通过，`isError:false`、`found:false` | 「查无此订单（O404）。」✅ 未编造状态/金额 | [logs](../w1-order/logs/2026-11-04T09-50-12-597Z-case/) |
| 测试 OERR | 通过 | 通过，`isError:true`，审计 `status:error` 带同一 callId，模型未重试 | 「查询 OERR 失败：工具返回模拟超时。这不是“查无此订单”，也无法据此判断订单状态。」✅ | [logs](../w1-order/logs/2026-11-04T09-50-18-613Z-case/) |
| fixture 变更复测 | 通过 | 未执行：待 Joe 亲手把 `orders.json` 的 O1001 改为 refunded 后运行 `case 04-refunded` | — | — |

注：第 2、3 项的区分部分由 `w1.patch.yml` 的 system prompt 引导（found=false 即无订单、工具错误即查询失败），属于提示词行为，不是 Harness 强制保证；Harness 层面的保证是 `isError` 与持久化事件。

没有将环境失败记成工具异常，也没有将工具层测试记成端到端通过。

## 解除阻塞后运行

待 Joe 确认独立官方 Node 24 安装，以及允许用限额测试 key 调用 DeepSeek API。安装位置计划为 `~/code/dsh-w1/node`，不改变全局 Node。获批并安装后：

```sh
export PATH="$HOME/code/dsh-w1/node/bin:$PATH"
node -v
npm ci --prefix "$HOME/code/dsh-w1" --no-audit --no-fund
node w1-order/run.mjs local
node w1-order/run.mjs config
node w1-order/run.mjs probe
```

probe 仍不使用 key；应推进到明确的缺少凭据错误，需查看日志，不能只看探测脚本退出码。Joe 自行在 `~/code/dsh-w1-home/.env` 设置 `DEEPSEEK_API_KEY=...`，不要写入仓库或聊天。获批模型调用后：

```sh
node w1-order/run.mjs all
```

每项创建新 headless 进程和新会话。批量运行只对第 4 项的证据 fixture 副本设置 refunded，原始数据不变；副本、独立预期和插件源码一并保存。这是受控复测，不等于 Joe 已亲自完成变更。

若由 Joe 编辑原始 orders.json，把 O1001 改为 refunded 后，可运行 `node w1-order/run.mjs case 04-refunded`。单项运行不改 fixture 或预期，数据不符就失败，01-paid 也不自动改回 paid。

脚本记录命令、版本、退出码、stdout/stderr、fixture、压缩会话原件及解压 JSONL；检查持久化 tool/call、tool/result 与审计行的 callId、文件 hash、实际工具集合和固定预期。机器检查通过后，review.json 仍将最终回答标成 pending-human-review：必须人工核对金额、状态、查无数据和查询失败，再更新交付状态。成功退出只表示该轮完成，不表示回答正确。

## 固定版本的执行链与四个概念

以下均为 commit b830ec9 的真实路径/符号，已与 npm 运行时代码核对；用 `git show dsh-v0.2.1-rc.5:<path>` 可复查。

| 环节 | 路径 / 符号 |
| --- | --- |
| 配置装载 | `packages/bundle/headless/cordis.patch.yml`；本地 apply / inject |
| schema 和注册 | `packages/core/tools/src/schema.ts:554` defineTool；`index.ts:1071` register、schemas |
| 模型循环 | `packages/core/agent-loop/src/agent.ts:267` preStep、buildRequest；约 549 行处理工具调用 |
| 调用和结果落盘 | `packages/core/agent-loop/src/tool-calls.ts:60` executeToolCalls；263 / 269 行 appendToolCall / appendToolResult |
| 策略与执行 | `packages/core/tools/src/index.ts` prepareScheduledExecution、1572 行 dispatchToolBody |
| 异常归一化 | 同文件 1917 行 toolErrorResult，转换为 isError:true 和 Error 文本 |
| 持久化路径 | `packages/session/session-persistence-jsonl/src/format.ts:298` logPath；`$DSH_HOME/sessions/<project>/<session>/session.v4.jsonl.zstd` |

1. **Harness 与模型分工**：模型决定调用和措辞，Harness 执行校验、策略、工具和持久化。提示词要求只调用一次属于行为引导，监督进程才负责实际停止。
2. **Cordis 与服务注入**：inject 等待 tools 服务，apply 注册工具；无需修改上游循环，参考固定版本[工具教程](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/docs/user/develop/basic/tool.zh.md)。
3. **Turn / Step**：一次用户请求为一个 Turn。典型查询需两个 Step：模型发工具调用、模型读取结果并回答。实际次数以日志为准。
4. **工具体审计 / 会话事件**：execute 日志只覆盖已进入函数的调用；持久化 tool/* 才能观察整条链路。headless stdout 是有限长投影，不能代替原始日志。O404 正常返回 found:false，OERR 抛错后变为 isError:true。参数校验发生在 defineTool 包装层，位于 pre-execute 之后。

版本差异：Claude 先前从 master 引用的 tools/src/pipeline.ts 和 batch.ts 不存在于本固定 tag；相关逻辑仍在 tools/src/index.ts 与 agent-loop/src/tool-calls.ts，不能沿用旧行号。

## 停止、恢复及方案偏差

- 单进程 180 秒；超时先 SIGTERM，5 秒未退出则 SIGKILL。
- 观察到非 get_order 或超过 3 次调用即终止。属于事件流监督，不能保证第四次工具体尚未开始；不是严格原子预算。
- 每次启动前检查 runtime 磁盘，少于 5 GiB 即停止；用例失败立即停止批量运行并保留日志。
- 主路径无服务器端口或驻留服务。父脚本收到 SIGINT/SIGTERM 会终止子进程并保留日志；自动监督依赖父脚本存活，强杀父脚本后应确认子进程已退出。
- 清理只涉及实验专用 dsh-w1、dsh-w1-home、dsh-w1-workspace 目录，先保留原始证据；不卸载全局 Node。上游只读克隆可以保留。

不接真实数据库、不改 Agent Loop、不对外发布。官方[安全说明](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/SAFETY.md)将其定义为未审计的开发者预览；独立目录不等于系统级隔离。

相对方案的偏差：采用 npm 预构建是 Joe 的明确选择；审计改写 stderr 是为保持 headless JSON；App Node 复用被签名限制阻塞，独立 Node 安装待确认。没有替换模型为 mock 并宣称通过，也没有使用 GUI 凭据。

跳过了跨工具审计系统和严格调用预算；只有扩展到更多工具或需要强制限制执行次数时再加。

## 安装到本机 Desktop（bundle）

`w1-order/` 本身是一个 bundle 包：[package.json](../w1-order/package.json) 声明 `dsh.bundle` → [bundle.patch.yml](../w1-order/bundle.patch.yml)（按包名插入 `w1-order`），`@deepseek-ai/*` 以 `peerDependencies` 由运行时提供（不安装、不打包）。`fixturePath` 默认读插件旁的 `orders.json`，`testMode` 默认 false。原实验运行时清单移至 [runtime-record/](../w1-order/runtime-record/)。

```sh
# 先完全退出 Desktop（Cmd+Q）
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add ~/code/weekly-handson/deepseek-harness/w1-order
# 重新打开 Desktop；卸载：
"$DSH" plugin --profile desktop remove dsh-w1-order
```

演练（隔离 `DSH_HOME=~/code/dsh-w1-desk-home`，不触碰 `~/.dsh`）：Desktop 内置 CLI（Electron Node 24.21.0）以 headless 模板建 profile，`plugin add` 以 `link:` 安装，`--dump-config` 出现 `# == dsh-w1-order` 层；真实 headless 查询 O1002 → `tool/result` `cancelled / 5800 / CNY`，`dataVersion` `fe75bb4eaae0`，审计行 callId 一致，退出码 0。pnpm 的 peer 警告属预期（peer 由 runtime resolution 提供）。

注意：`link:` 指向仓库目录——改 `orders.json` 下次调用即生效，改代码需重启 Desktop；移动或删除该目录会导致插件加载失败（Desktop 恢复对话框可禁用第三方插件）。
