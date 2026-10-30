# DeepSeek Harness

- 周次：W1 · 2026.11.02 – 11.08（10.30 提前开始）
- 状态：进行中
- 计划：[plan.md](plan.md)

## 环境基线

- deepseek-harness commit：
- node / pnpm：
- 测试模型：

上游 clone 放在 `~/code/deepseek-harness`，练习包按计划解压到它的根目录，实验都在那里做。每完成一个实验，把插件代码同步回本目录并提交一次：

```sh
rsync -a --delete --exclude node_modules --exclude dist \
  ~/code/deepseek-harness/scratch-plugin/ ~/code/weekly-handson/deepseek-harness/scratch-plugin/
```

## 实验进度

- [ ] 0. 基线：练习包原样同步进来并提交，后续 commit 的 diff 就是「代码修改」
- [ ] 1. 正常工具调用：查询 O-1001 → `logs/1-normal.log`
- [ ] 2. 增加审计能力：execute() 记录订单 ID、耗时、成功/失败 → `logs/2-audit.log`
- [ ] 3. 模拟异常与缺失数据：O-ERR 超时 vs O-404 → `logs/3-error-vs-404.log`
- [ ] 验收报告（用练习包里的模板）→ [report.md](report.md)

## 核心概念

- Cordis 插件：
- 服务注入：
- Agent Turn / Step：
- Tool Registry：
- Session Event Log：

## 验收重点

### execute() 日志 vs 工具执行流水线审计

### 查不到业务数据 vs 工具执行异常

### 决定下一步动作的逻辑 vs 强制执行限制的逻辑

## 过程日志

### 2026-10-30

## 成果

- 一句话收获：
- 还没搞懂：
