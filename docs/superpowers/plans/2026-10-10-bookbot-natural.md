# 书单自然语言发言分析实现计划

> **面向 AI 代理的工作者：** 使用 superpowers:subagent-driven-development 实现一个完整自然语言查询任务，先规格审查、再质量审查。实现者使用 TDD；root 验证并提交本地分支。

**目标：** @或引用机器人时理解自然发言，只回复书籍内容，无关内容固定拒绝。

**架构：** 原消息队列持久保存回复申请和核实的机器人引用；媒体准备后用无工具 DSH 产生严格查询意图，完成记录后由本地 SQL 查询与确定性渲染回复。规划不能直接写库、执行 SQL 或输出自由回答。

**技术栈：** 当前 Node.js、SQLite、DSH 受限预设、SnowLuma 引用查询与 QQ 转写；不新增依赖。

## 任务 1：自然语言与本群查询

文件职责：新 `src/bookbot-query.js` 放严格计划校验、范围 prompt、固定回复常量；修改 `src/bookbot-store.js` 增量迁移回复申请/引用、范围查询与本群昵称/标签目录；`src/bookbot.js` 处理真实触发、后台规划、当前授权与渠道复核、落库后回复；`src/bookbot-extractor.js` 或注入适配器复用 runPrompt；`src/bridge.js` 注入安全本群引用解析和规划回调。新 `scripts/test-bookbot-natural.mjs`，修改 harness、demo、package/config/guide。

- [x] 先写并运行失败测试：@机器人「这周有哪些慢热科幻小说」进入自然语言分析，普通聊天不回复，unrelated 固定回复；缺功能的失败须真实可见。

```javascript
await bot.handle(event('n1', '这周有哪些慢热科幻小说', { atBot: true }));
await bot.flush({ force: true });
assert.equal(planned[0].text, '这周有哪些慢热科幻小说');
assert.match(sent[0], /科幻|慢热/);
```

- [x] 增量迁移消息回复申请和核实机器人引用；引用必须同群、真实 bot 发送者，错误不冒充 bot；旧库、去重、撤销与清理继续有效。
- [x] 实现严格六字段计划、范围 prompt 与专用 DSH 规划；拒绝附加 SQL、身份或自由回答。无关固定输出「这是不相关内容」，服务故障不会误判为无关。

```javascript
assert.throws(() => validateQueryPlan({action:'query',period:'all',title:null,user:null,tags:[],kind:'recommend',sql:'DELETE FROM messages'}));
```

- [x] 参数化本群复合查询，同时应用 period/title/user/tags/kind；统计全命中记录，昵称不猜身份。上海昨天和上周使用精确半开范围；既有单命令查询输出继续通过。
- [x] 后台媒体准备后规划原发言/QQ转写；OCR作为引用材料，不作为查询指令。记录成功后回复 query/record/clarify/unrelated；失败仅重试原消息，不重复成功回复。每次 await 后和最终 handoff 检查来源、授权、启用渠道，旧规划不能绕过关闭或撤销。服务错误提示可能在重试时再次发送，跨崩溃发送为尽力交付。
- [x] 真实桥接注入安全引用解析及规划，保持专用预设、模型选择和生命周期；普通通用聊天、onlyBooks、静默、关闭模式与审计不变。
- [x] 配置示例与 guide 加 naturalLanguage，演示自然语句、复合查询和无关拒绝；新增测试纳入 test:bookbot，测试不读取真实凭据或联网。
- [x] 运行 test:bookbot、demo:bookbot、完整 test:audit、语法与 diff 检查；逐项核对 7 项原有失败。
- [x] 独立规格审查、质量审查与必要修复；root 复核、更新验证记录并提交本地分支。
