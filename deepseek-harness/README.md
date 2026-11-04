# W1 · DeepSeek Harness

Joe 的只读模拟订单助手实验，以 [v3 任务卡](ai-delivery-learning-v3/W01-harness.md) 为准。旧版 `plan.md` 保留作历史资料。

- 交付及运行说明：[docs/DELIVERY.md](docs/DELIVERY.md)
- 插件：[w1-order/order-plugin.ts](w1-order/order-plugin.ts)
- 独立数据：[w1-order/orders.json](w1-order/orders.json)
- 冻结输入与预期：[w1-order/cases.json](w1-order/cases.json)
- 验证入口：[w1-order/run.mjs](w1-order/run.mjs)

使用 npm 预构建 `@deepseek-ai/dsh@0.2.1-rc.5`，源码基线为 `b830ec950faba0a46dda564be3e2d854afed94f1`，无需编译 Harness。

| 项目 | 当前状态 |
| --- | --- |
| 正常查询、查无数据、模拟超时、fixture 变更 | 直接工具执行验证通过 |
| 参数及 fixture 错误处理 | 本地验证通过 |
| patch 配置组合、关闭内置工具及日志上传 | dump-config 通过；运行时 `request/header` 工具集合仅 `get_order` |
| headless 真实启动（Node 24.22.2） | 通过到预期的 `MISSING_CREDENTIAL`，未发出模型请求 |
| 真实模型验收 1–3（O1001 / O404 / OERR） | 通过；CPA 网关 `gpt-6-luna`，回答已人工核对 |
| 验收 4（改 fixture 后新会话复测） | 待 Joe 亲手修改 `orders.json` 后运行 |

运行 Harness 用 brew keg-only `node@24`（`PATH=/opt/homebrew/opt/node@24/bin:$PATH`），全局 Node 23 不变。证据及下一步见交付文档。
