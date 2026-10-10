# 网文书单 Bot 实现计划

> **面向 AI 代理的工作者：** 使用 superpowers:subagent-driven-development 执行，再依次进行规格审查和代码质量审查。

**目标：** 在 qq-bridge 中提供持久化的网文讨论记录和按需群书单查询。

**架构：** 独立 SQLite 书库与后台抽取队列，群消息入口在仿真唤醒判断之前采集。专用无工具 DSH preset 返回经校验的结构化提取结果；群查询由数据库计算并格式化。

**技术栈：** Node.js 22.13+/24、现有 DSH 客户端、SQLite、node:test。

## 任务 1：最小可用功能

文件职责：`src/bookbot-store.js` 保存消息、队列、书籍讨论并查询；`src/bookbot-extractor.js` 构造上下文并校验来源；`src/bookbot.js` 管理分批处理和查询命令；`src/bridge.js` 接入 QQ 与 DSH；`scripts/test-bookbot*.mjs` 测试；`scripts/demo-bookbot.mjs` 离线演示；`docs/guides/BOOKBOT.md` 使用说明。preset 安装及配置沿用仓库现有机制。

- [x] 写行为测试，再执行 `node --test scripts/test-bookbot*.mjs`，确认因缺失功能失败。
- [x] 实现 SQLite 消息去重和任务状态，事务提交提取结果及处理完成状态；失败不丢消息。
- [x] 实现消息来源校验、固定发送者归属、各人评价及字数快照、按群查询与日期边界。
- [x] 实现后台批次与显式查询/撤销命令，配置禁用时不创建数据库或改变原行为。
- [x] 集成独立无工具 DSH 抽取会话及群消息入口；失败只记录运维日志，群里不刷错误。
- [x] 添加配置示例、离线演示和安装说明，更新安全基线中的新增落盘及群准入行为。
- [x] 执行 `npm run test:bookbot`、`npm run demo:bookbot`、`npm run test:audit` 和语法检查；确认演示不访问真实 DSH、QQ 或 state。新增测试 24/24；原有完整套件 24/31，与开发前 7 项失败一致，详见基线记录。
- [x] 规格审查、质量审查及必要修复；提交本地分支，不推送外部仓库。

## 明确的测试断言示例

```javascript
assert.equal(store.capture(message), true);
assert.equal(store.capture(message), false);
assert.equal(store.query('9', '100', { type: 'period', value: 'today' }, now).totalBooks, 1);
assert.equal(store.query('9', '200', { type: 'period', value: 'today' }, now).totalBooks, 0);
```

日期固定为测试夹具，查询参数必须由当前群上下文提供。模型输出的 `sourceId` 必须映射到真实输入消息，而不是接受模型提供的 QQ 号。
