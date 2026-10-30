# W1 技术探索：DeepSeek Harness

> 学习计划原文（2026-10-30 提前发放），只去掉了链接追踪参数和网页排版噪音。

- 时间：2026.11.02 – 11.08，10 月 30 日即可提前开始
- 预计：2 小时

## 一、本周学习目标

搞清楚 DeepSeek Harness 如何组织 Agent Loop、模型调用、工具执行与状态管理，并自己实现一个可以被 Agent 调用的插件。

本周不是学习如何使用一个 AI 编程助手，而是从开发者角度拆解它的运行机制。

本周重点理解的执行链路：

```
用户请求 / 会话输入
  → Agent Loop · 上下文与工具 Schema 组装
  → LLM 推理 / Tool Call
  → Tool Registry / Execution Pipeline
      参数校验 → 执行策略 → 工具执行 → 结果处理
  → Tool Result → Session Log → 下一次模型请求
```

这是用于学习的简化执行链路。实际 Harness 还包含事件、流式输出、错误恢复和多个扩展点。

本周只需要掌握五个核心概念：Cordis 插件、服务注入、Agent Turn / Step、Tool Registry、Session Event Log。

其中尤其需要理解：一个 Turn 可以包含多次 Step，而 Step 包含一次模型请求及其工具执行；持久化会话事件与进程内实时事件的职责不同。

## 二、精选学习资料

项目仍处在开发者预览阶段，接口可能有破坏性变更，记录实际使用的 Git commit。

1. [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)（5 分钟）：阅读 README 的 Run 和 Development，建立工程整体印象。
2. [官方架构说明（中文）](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)（15 分钟）：重点阅读 Cordis、Core packages、Turn flow、Session log。最重要的一份资料。
3. [开发你的第一个插件（中文）](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.zh.md)（5 分钟）：学会 apply(ctx)、inject、插件装载及 cordis.yml 配置。
4. [编写 Tool 插件（中文）](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.zh.md)（5 分钟）：理解 defineTool、parameters、execute 和 output.render。
5. [官方安全说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)（运行前阅读）：插件是受信任代码，沙箱和审批不能保证完全隔离。

不要一开始就阅读全部源码。先读这五份资料，再围绕实验追踪关键代码。

## 三、动手实验

实验包（ZIP）：插件源码、环境准备脚本、详细指南、验收报告模板。练习包里的 `get_mock_order` 已经实现基本查询，审计日志和模拟异常留了两个 TODO 需要自己完成。

### 1. 环境准备

官方仓库当前声明需要 Node.js ≥24.9.0、pnpm 11.28.5。

```sh
node -v
pnpm -v

git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness

git rev-parse HEAD
pnpm install
pnpm run build
```

记录 `git rev-parse HEAD` 输出，作为本周实验的版本基准。

把 ZIP 解压到这个仓库根目录，然后执行：

```sh
sh scratch-plugin/prepare.sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

浏览器打开 `http://127.0.0.1:3080`，在 Settings → Models 配置可用的测试模型，再选择只包含合成数据的 Workspace。使用测试密钥，不授权访问生产目录。

### 2. 三个实验

| 实验 | 时长 | 内容 |
| --- | --- | --- |
| 正常工具调用 | 15 分钟 | 让 Agent 查询 O-1001，确认工具输出和最终回答 |
| 增加审计能力 | 20 分钟 | 在 execute() 里记录订单 ID、执行耗时、成功或失败 |
| 模拟异常与缺失数据 | 25 分钟 | 让 O-ERR 抛出模拟超时；再查询 O-404，对比两种结果 |

代码练习结束后，再用约 25 分钟回答验收问题、填写技术卡片。

## 四、验收

把练习包里的验收报告填好，附上代码修改和关键日志。验收时先评估复现证据，再追问架构原理，按 100 分评分标准评审。

本周特别会考察能否区分：

- 工具自身的 `execute()` 日志与整个工具执行流水线的审计。
- 查询不到业务数据与工具执行异常。
- Agent Loop 中负责决定下一步动作的逻辑，以及负责强制执行限制的逻辑。

练习包已完成 TypeScript 语法转译检查和配置脚本结构检查，但没有在 Mac 上实际启动过完整 Harness，这些检查不能当成端到端运行成功。

第一步：启动 Harness，并成功让 Agent 调用一次 `get_mock_order`。
