# 书单图片与 QQ 语音记录实现计划

> **面向 AI 代理的工作者：** 使用 superpowers:subagent-driven-development 执行一个完整媒体接入任务，先规格审查，再代码质量审查。遵循 TDD；root 验证并提交本地分支。

**目标：** 图片及 QQ 自带语音转写进入持久书单，保留出处且不误算截图上传者的推荐。

**架构：** 采集只落盘文字与媒体定位，后台按消息识别并缓存，再分批书单抽取。识别与抽取共用已有独立无工具 DSH 会话生命周期；SQL 查询携带各条目的实际来源类型。

**技术栈：** 当前 Node.js / SQLite、现有 SnowLuma `fetch_ptt_text`、DSH 图片 content、node:test；不增加外部依赖。

## 任务 1：媒体接入与验收

文件职责：新建 `src/bookbot-media.js` 集中媒体来源、识别结果校验、可分析文字与出处推导；修改 `src/bookbot-store.js` 幂等迁移、识别缓存、清理和来源查询；`src/bookbot-extractor.js` 复用隔离生命周期做图片转录及媒体证据校验；`src/bookbot.js` 采集媒体、逐消息准备/重试、出处渲染；`src/bridge.js` 仅注入已有图片获取与 QQ 转写接口。新建 `scripts/test-bookbot-media.mjs`，扩展现有桥接 harness、离线演示、配置和说明。必要时改书单 persona，并重新生成唯一受影响的预设产物。

- [x] 写行为测试并验证失败：纯图片/语音消息也入队，实际身份来自事件，旧库有数据时可迁移；失败原因是媒体功能缺失。

```javascript
await bot.handle(event('101', [{ type: 'image', data: { file: 'cover.png' } }]));
await bot.handle(event('102', [{ type: 'record', data: { file: 'voice.silk' } }]));
assert.equal(store.groups(now)[0].count, 2);
```

- [x] 迁移消息的媒体/识别字段及条目出处字段（兼容原文字记录）。保存可见文字、QQ 转写及其渠道；识别缓存写入必须检查仍处于 processing，取消消息不能恢复。普通非书籍聊天到期清理媒体与转写，保留去重身份。
- [x] 后台先准备每条媒体消息，失败只 retry 该消息，继续处理本群其他消息。成功识别入库后再抽取，抽取失败重试复用识别缓存；上下文包含先前已识别媒体，但仍限定同账号同群。
- [x] 图片转录调用复用 `DshBookExtractor` 的受限预设、等待器注册、超时、follow/forget、归档和缓存释放；严格验证 JSON 转录结果，空文字图片可完成而不编造内容。
- [x] 桥接图片获取通过既有 `resolveMediaList`/`fetchOneBotImage`，禁止把获取失败占位当作成功；超过既有上限保留待处理。语音只请求配置的 SnowLuma `fetch_ptt_text({message_id})`，验证状态、非空文本、长度和超时，不请求语音段提供的 URL。
- [x] 抽取仍只接受现有九个 JSON 字段；来源类型由本地保存的证据推导，模型不能提供身份或出处。图片独有证据的条目必须是 mention、opinion 为 null；原文附言可以引用已识别书名表示本人推荐。

```javascript
assert.throws(() => validateExtraction({ entries: [imageRecommendation] }, [source]), /image|图片|opinion|推荐/i);
assert.equal(store.query('9', '10', { type: 'period', value: 'today' }, now).recommenders, 0);
```

- [x] 查询图片内容使用分享者措辞；语音与图片字数/状态分别注明识别渠道，保留消息和时间。推荐人的语音来源也可见；默认字符限制及首本书名保留行为继续成立。
- [x] 配置示例增加 `bookbot.media.images: true` / `voice: "qq"`，支持关闭渠道。升级 guide、安全基线和离线演示，新增媒体测试纳入 `npm run test:bookbot`。不启动实际 DSH/QQ，不改真实 config/state。
- [x] 运行 `npm run test:bookbot`、`npm run demo:bookbot`、`npm run test:audit`、语法与 diff 检查；对比已有 7 项基线失败。
- [x] 完成独立规格审查、代码质量审查及必要修复，root 复核后本地提交；不推送、不创建 PR。
