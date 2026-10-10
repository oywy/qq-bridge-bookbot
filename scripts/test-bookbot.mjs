import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';

const storeModule = await import('../src/bookbot-store.js').catch(() => ({}));
const extractModule = await import('../src/bookbot-extractor.js').catch(() => ({}));
const botModule = await import('../src/bookbot.js').catch(() => ({}));
function fixture() {
  assert.equal(typeof storeModule.BookbotStore, 'function', 'persistent bookbot store must exist');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bookbot-test-'));
  const store = new storeModule.BookbotStore(path.join(dir, 'books.sqlite'));
  return { store, dir, close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const message = (messageId, text, extras = {}) => ({ accountId: '9', groupId: '10', messageId, userId: '20', name: '甲', text, time: Date.parse('2026-10-10T03:00:00Z'), quoteId: null, ...extras });
const entry = (sourceId, extras = {}) => ({ sourceId, title: '星河', author: null, kind: 'recommend', tags: ['科幻'], opinion: '好看', wordCount: '120万字', status: '连载', evidence: '星河好看，120万字，连载', ...extras });

test('durable queue deduplicates by account/group/message and recovers interrupted batches', () => {
  const f = fixture();
  try {
    assert.equal(f.store.capture(message('1', '星河好看，120万字，连载')), true);
    assert.equal(f.store.capture(message('1', '重复')), false);
    f.store.capture(message('1', '另一个群', { groupId: '11' }));
    f.store.capture(message('1', '另一个机器人', { accountId: '8' }));
    const batch = f.store.claim('9', '10', 10, Date.now());
    assert.equal(batch.length, 1);
    f.store.close();
    f.store = new storeModule.BookbotStore(path.join(f.dir, 'books.sqlite'));
    assert.equal(f.store.claim('9', '10', 10, Date.now()).length, 1);
    f.store.retry(batch, Date.now() + 1000);
    assert.equal(f.store.claim('9', '10', 10, Date.now()).length, 0);
    assert.equal(f.store.claim('9', '10', 10, Date.now() + 2000).length, 1);
  } finally { f.store.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('validation is atomic, binds identity to pending source, and rejects context source IDs', () => {
  const f = fixture();
  try {
    f.store.capture(message('1', '星河好看，120万字，连载'));
    const batch = f.store.claim('9', '10', 10, Date.now());
    assert.equal(typeof extractModule.validateExtraction, 'function', 'strict validator must exist');
    const validate = (items) => extractModule.validateExtraction(JSON.stringify({ entries: items }), batch, []);
    assert.throws(() => validate([entry('1'), entry('999')]), /source/i);
    assert.throws(() => validate([entry('1', { userId: '666' })]), /field|key/i);
    assert.throws(() => validate([entry('1', { kind: 'love' })]), /kind/i);
    assert.throws(() => validate([entry('1', { evidence: '伪造证据' })]), /evidence/i);
    assert.throws(() => validate([entry('1', { title: '凭空编造' })]), /title/i);
    assert.equal(f.store.query('9', '10', { type: 'title', value: '星河' }).books.length, 0);
    f.store.complete(batch, validate([entry('1')]));
    const result = f.store.query('9', '10', { type: 'title', value: '星河' });
    assert.equal(result.books[0].entries[0].userId, '20');
    assert.equal(result.books[0].entries[0].messageId, '1');
    assert.equal(f.store.query('9', '11', { type: 'title', value: '星河' }).books.length, 0);
    assert.throws(() => extractModule.validateExtraction(JSON.stringify({ entries: [entry('1')] }), [], batch), /source/i);
  } finally { f.close(); }
});

test('quoted context resolves titles without inventing attribution; author variants stay distinct', () => {
  const f = fixture();
  try {
    f.store.capture(message('1', '星河好看，120万字，连载'));
    let batch = f.store.claim('9', '10', 10, Date.now());
    f.store.complete(batch, extractModule.validateExtraction(JSON.stringify({ entries: [entry('1')] }), batch, []));
    f.store.capture(message('2', '这本节奏慢', { userId: '21', quoteId: '1' }));
    batch = f.store.claim('9', '10', 10, Date.now());
    const context = f.store.context(batch, 5, 20000);
    assert.equal(context.some(m => m.messageId === '1'), true);
    const output = { entries: [entry('2', { kind: 'review', evidence: '这本节奏慢', opinion: '节奏慢', wordCount: null, status: null, tags: [] })] };
    f.store.complete(batch, extractModule.validateExtraction(JSON.stringify(output), batch, context));
    f.store.capture(message('3', '乙作者的星河不错'));
    batch = f.store.claim('9', '10', 10, Date.now());
    f.store.complete(batch, extractModule.validateExtraction(JSON.stringify({ entries: [entry('3', { author: '乙作者', evidence: '乙作者的星河不错', wordCount: null, status: null, opinion: '不错' })] }), batch, []));
    const result = f.store.query('9', '10', { type: 'title', value: '星河' });
    assert.equal(result.books.length, 2);
    assert.equal(result.books.find(b => b.author === null).entries.find(e => e.kind === 'review').userId, '21');
    assert.equal(result.recommenders, 1);
  } finally { f.close(); }
});

test('Shanghai day/week boundaries and recommendation counts exclude mentions/reviews', () => {
  const f = fixture();
  try {
    const add = (id, at, userId, title, kind) => {
      f.store.capture(message(id, title, { time: Date.parse(at), userId }));
      const batch = f.store.claim('9', '10', 10, Date.now());
      f.store.complete(batch, [{ ...entry(id), title, kind, evidence: title, wordCount: null, status: null }]);
    };
    add('a', '2026-10-09T15:59:59Z', '1', '昨日书', 'recommend');
    add('b', '2026-10-09T16:00:00Z', '2', '今日书', 'recommend');
    add('c', '2026-10-10T00:00:00Z', '2', '今日书', 'recommend');
    add('d', '2026-10-10T00:00:00Z', '3', '提及书', 'mention');
    add('e', '2026-10-04T16:00:00Z', '4', '周一书', 'recommend');
    add('f', '2026-10-04T15:59:59Z', '5', '上周书', 'recommend');
    const now = Date.parse('2026-10-10T03:00:00Z');
    const today = f.store.query('9', '10', { type: 'period', value: 'today' }, now);
    assert.equal(today.totalBooks, 1); assert.equal(today.recommenders, 1);
    const week = f.store.query('9', '10', { type: 'period', value: 'week' }, now);
    assert.equal(week.totalBooks, 3); assert.equal(week.recommenders, 3);
    assert.match(botModule.renderBookQuery(today), /本群首次记录/);
  } finally { f.close(); }
});

test('withdrawal authorizes original speaker/owner and tombstone defeats in-flight completion', () => {
  const f = fixture();
  try {
    f.store.capture(message('1', '星河好看，120万字，连载'));
    const batch = f.store.claim('9', '10', 10, Date.now());
    assert.equal(f.store.cancel('9', '10', '1', '666', '123').ok, false);
    assert.equal(f.store.cancel('9', '10', '1', '20', '123').ok, true);
    f.store.complete(batch, [entry('1')]);
    assert.equal(f.store.query('9', '10', { type: 'title', value: '星河' }).totalBooks, 0);
    assert.equal(f.store.capture(message('1', '星河好看，120万字，连载')), false);
    f.store.capture(message('2', '星河'));
    assert.equal(f.store.cancel('9', '10', '2', '123', '123').ok, true);
  } finally { f.close(); }
});

test('opt-in authorization fails closed and commands have a narrow Chinese matcher', () => {
  assert.equal(typeof botModule.bookbotAllowed, 'function', 'bookbot authorization must exist');
  const cfg = { bookbot: { enabled: true, groups: ['10'] }, allow: { groups: ['10'] }, deny: { groups: [] } };
  assert.equal(botModule.bookbotAllowed('10', cfg), true);
  assert.equal(botModule.bookbotAllowed('11', cfg), false);
  assert.equal(botModule.bookbotAllowed('10', { ...cfg, bookbot: { enabled: true, groups: [] } }), false);
  assert.equal(botModule.bookbotAllowed('10', { ...cfg, allow: { groups: [] }, allowAllWhenEmpty: true }), false);
  assert.equal(botModule.bookbotAllowed('10', { ...cfg, deny: { groups: ['10'] } }), false);
  assert.equal(botModule.bookbotAllowed('10', { ...cfg, allow: {group:[],groups:['10']} }), false);
  assert.equal(botModule.bookbotAllowed('10', { ...cfg, deny: {group:['10'],groups:[]} }), false);
  for (const [text, type, value] of [['/书单 今天','period','today'],['/书单 本周','period','week'],['/书单 近七天','period','seven'],['/书单 查 星河','title','星河'],['/书单 推荐人 20','user','20'],['/书单 找 科幻 慢热','tags','科幻 慢热'],['今天推书','period','today'],['查书 星河','title','星河']]) {
    const command = botModule.parseBookCommand(text, { mentioned: true });
    assert.deepEqual(command, { type, value });
  }
  assert.equal(botModule.parseBookCommand('今天推书'), null);
  assert.equal(botModule.parseBookCommand('随便聊天'), null);
});

test('worker considers non-keyword text, retries errors, stays silent, and ignores self/unauthorized', async () => {
  const f = fixture(); let attempts = 0; const sent = [];
  const cfg = { ownerQQ: '123', bookbot: { enabled: true, groups: ['10'], onlyBooks: true, batchMs: 15, retryMs: 1 }, allow: { groups: ['10'] } };
  try {
    assert.equal(typeof botModule.Bookbot, 'function', 'worker must exist');
    const bot = new botModule.Bookbot({ store: f.store, getConfig: () => cfg, extract: async batch => { attempts++; if (attempts === 1) throw new Error('broken JSON'); return { entries: [] }; }, send: async (key, reply) => sent.push({key,reply}), now: () => Date.now() });
    const event = (id, text, user = '20', group = '10') => ({ self_id: '9', group_id: group, user_id: user, message_id: id, message: [{ type: 'text', data: { text } }], time: Math.floor(Date.now()/1000) });
    assert.equal(await bot.handle(event('x', '天色真好', '9')), false);
    assert.equal(await bot.handle(event('y', '天色真好', '20', '11')), false);
    assert.equal(await bot.handle(event('1', '这本还不错')), true);
    await bot.flush({ force: true });
    assert.equal(attempts, 1); assert.equal(sent.length, 0);
    await new Promise(resolve => setTimeout(resolve, 5));
    await bot.flush({ force: true }); assert.equal(attempts, 2);
    assert.equal(f.store.claim('9', '10', 10, Date.now()).length, 0);
    await bot.handle(event('2', '/书单 今天')); assert.equal(sent.length, 1);
    cfg.deny = { groups: ['10'] }; await bot.handle(event('3', '/书单 今天')); assert.equal(sent.length, 1);
    await bot.stop();
  } finally { f.close(); }
});

test('DSH extractor registers before prompt, isolates every batch, and cleans rejected/timeout/late turns', async () => {
  assert.equal(typeof extractModule.DshBookExtractor, 'function', 'isolated DSH adapter must exist');
  let adapter; const created = []; const retired = []; let mode = 'success';
  const success = value => ({ result: { ok: true, value } });
  const { createTurnCollector } = await import('../src/dsh-client.js');
  const api = { workspace: { create: async () => success({ workspace: { workspaceId: 'w' } }), archiveSession: async ({sessionId}) => {retired.push(sessionId); return success({});} }, events: {follow() {}}, sessions: { create: async params => { created.push(params); return success({sessionId: 's'+created.length}); }, prompt: async ({sessionId}) => {
    if (mode === 'reject') return { result: { ok: false, error: { message: 'rejected' } } };
    if (mode === 'success') {
      adapter.onEvent(sessionId, { type:'turn/start', data:{turn:1} });
      adapter.onEvent(sessionId, { type:'assistant/message', data:{turn:1,message:{content:[{type:'text',text:'{"entries":[]}' }]}} });
      adapter.onEvent(sessionId, { type:'turn/end', data:{turn:1,reason:{kind:'completed'}} });
    }
    return success({});
  } }, stopSessionWork: async () => {} };
  adapter = new extractModule.DshBookExtractor({ api, createTurnCollector, resolvePreset: () => 'book-extractor', workspacePath: os.tmpdir(), timeoutMs: 10 });
  assert.deepEqual(await adapter.extract([], []), { entries: [] });
  mode = 'reject'; await assert.rejects(adapter.extract([], []), /reject/i);
  mode = 'timeout'; await assert.rejects(adapter.extract([], []), /timeout/i);
  assert.equal(adapter.onEvent('s3', {type:'turn/start',data:{turn:1}}), false);
  mode = 'success'; await adapter.extract([], []);
  assert.equal(created.length, 4); assert.equal(retired.length, 4); assert.equal(adapter.pending.size, 0);
  assert.equal(created.every(p => p.agentPreset === 'book-extractor'), true);
  const missing = new extractModule.DshBookExtractor({ api, createTurnCollector, resolvePreset: () => '', workspacePath: os.tmpdir() });
  await assert.rejects(missing.extract([], []), /preset/i); assert.equal(created.length, 4);
});

test('book extractor preset generation and execution guard deny every tool', async () => {
  const guard = await import('../plugins/qq-agent-presets/book-tool-deny.mjs').catch(() => ({}));
  assert.equal(typeof guard.apply, 'function', 'all-tools execution guard must exist');
  let fn; let filter; guard.apply({ tools: { restrict: f => { filter=f; }, guard: f => { fn = f; } } });
  assert.deepEqual(filter, { allow: [] });
  for (const name of ['mcp__snowluma__qq_send_message','mcp__web-search-safe__web_search','bash','read','ask_user_question','todo_write','future_tool','',null,undefined]) assert.equal(typeof fn({ name }), 'string');
  const { buildPatches, PRESETS } = await import('./build-agent-preset-patches.mjs');
  assert.equal(PRESETS.includes('book-extractor'), true);
  assert.equal(buildPatches({ check:true }).some(p => p.changed), false);
  const pkg = JSON.parse(fs.readFileSync(new URL('../plugins/qq-agent-presets/package.json', import.meta.url)));
  assert.equal(pkg.dsh.bundle.patch.includes('./presets/book-extractor.patch.yml'), true);
});

test('retired extraction sessions leave real client follow state and clean caches even if retirement callback fails', async () => {
  const {NodeApiClient,createTurnCollector}=await import('../src/dsh-client.js');
  const api=new NodeApiClient('http://127.0.0.1:1');
  let mode='success';let count=0;let adapter;const archived=[];const stopped=[];const cache=new Set();
  const success=value=>({result:{ok:true,value}});
  api.callUnary=async (method,params)=>{
    const endpoint=method.replaceAll('.','/');
    if(endpoint==='workspace/create') return success({workspace:{workspaceId:'w'}});
    if(endpoint==='session/create') return success({sessionId:'real-follow-'+(++count)});
    if(endpoint==='workspace/archiveSession') {archived.push(params.sessionId);return success({});}
    if(endpoint==='session/prompt') {
      const sid=params.sessionId;
      assert.equal(api._desiredFollows.has(sid),true);
      if(mode==='reject') return {result:{ok:false,error:{message:'rejected'}}};
      if(mode==='success') {
        adapter.onEvent(sid,{type:'turn/start',data:{turn:1}});
        adapter.onEvent(sid,{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'{"entries":[]}' }]}}});
        adapter.onEvent(sid,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
      }
      return success({});
    }
    return success({});
  };
  api.stopSessionWork=async sid=>{stopped.push({sid,followed:api._desiredFollows.has(sid)});};
  adapter=new extractModule.DshBookExtractor({api,createTurnCollector,resolvePreset:()=> 'book-extractor',workspacePath:os.tmpdir(),timeoutMs:10,
    selectModel:async sid=>{cache.add(sid);},onRetire:sid=>{cache.delete(sid);if(sid==='real-follow-1')throw new Error('cleanup callback failed');}});
  for(const next of ['success','reject','timeout','success']) {
    mode=next;
    if(mode==='success') await adapter.extract([],[]); else await assert.rejects(adapter.extract([],[]),/reject|timeout/i);
    const sid='real-follow-'+count;
    assert.equal(api._desiredFollows.has(sid),false);
    assert.equal(adapter.onEvent(sid,{type:'turn/start',data:{turn:99}}),false);
    assert.equal(cache.has(sid),false);
  }
  assert.equal(api._desiredFollows.size,0);assert.equal(archived.length,4);
  assert.deepEqual(stopped.map(s=>s.followed),[false,false,false,false],'must forget before stopping every batch');
});

test('markdown legacy/new content is ingested once and markdown book commands are parsed', async () => {
  const f=fixture();const sent=[];
  const cfg={allow:{groups:['10']},bookbot:{enabled:true,groups:['10'],onlyBooks:true}};
  const bot=new botModule.Bookbot({store:f.store,getConfig:()=>cfg,extract:async()=>({entries:[]}),send:async(_,reply)=>sent.push(reply)});
  const event=(id,data)=>({self_id:'9',group_id:'10',user_id:'20',message_id:id,message:[{type:'markdown',data}],time:Math.floor(Date.now()/1000)});
  try {
    await bot.handle(event('legacy',{content:'推荐《旧书》'}));
    await bot.handle(event('new',{text:'推荐《新书》',content:'推荐《新书》'}));
    const batch=f.store.claim('9','10',10,Date.now());
    assert.deepEqual(batch.map(m=>m.text),['推荐《旧书》','推荐《新书》']);
    f.store.complete(batch,[]);
    await bot.handle(event('query',{text:'/书单 今天',content:'ignored fallback'}));
    assert.equal(sent.length,1);assert.match(sent[0],/今天推书/);
  } finally {await bot.stop();f.close();}
});

test('bridge releases applied-model and event-model caches after a book extraction batch', async () => {
  const {bridgeHarness}=await import('./audit-bridge-harness.mjs');
  const bridge=await bridgeHarness({config:{bookbot:{enabled:true,groups:['456'],onlyBooks:true}}});
  try {
    bridge.setPresets(['book-extractor']);
    const adapter=bridge.getBookExtractor();
    bridge.api.sessions.prompt=async ({sessionId})=>{
      bridge.recordSessionUsage(sessionId,{type:'model/selection',data:{model:'fixture',provider:'fixture'}});
      assert.equal(bridge.getModelCacheSizes().applied,1);assert.equal(bridge.getModelCacheSizes().models,1);
      adapter.onEvent(sessionId,{type:'turn/start',data:{turn:1}});
      adapter.onEvent(sessionId,{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'{"entries":[]}' }]}}});
      adapter.onEvent(sessionId,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
      return {result:{ok:true,value:{}}};
    };
    await adapter.extract([],[]);
    assert.equal(bridge.getModelCacheSizes().applied,0);assert.equal(bridge.getModelCacheSizes().models,0);
  } finally {await bridge.close();}
});

test('book snapshots do not build generic collectors; generic reconnect still restores and retired snapshots are ignored', async () => {
  const {bridgeHarness}=await import('./audit-bridge-harness.mjs');
  const bridge=await bridgeHarness({config:{bookbot:{enabled:true,groups:['456'],onlyBooks:false}}});
  const snapshot={projections:{values:{modelSelection:{lastUsed:{model:'fixture',provider:'fixture'}}}},records:[{type:'event',event:{type:'turn/start',data:{turn:1}}}]};
  try {
    bridge.setMode('chat');bridge.setPresets(['qq-chat','book-extractor']);
    const ordinary=await bridge.ensureSession('group:456');
    bridge.recordSessionSnapshot(ordinary,snapshot);assert.equal(bridge.getCollectorCount(),1);
    const adapter=bridge.getBookExtractor();let bookSession;
    bridge.api.sessions.prompt=async ({sessionId})=>{
      bookSession=sessionId;bridge.recordSessionSnapshot(sessionId,snapshot);
      assert.equal(bridge.getCollectorCount(),1,'book snapshot must not rebuild generic collector');
      adapter.onEvent(sessionId,{type:'turn/start',data:{turn:1}});
      adapter.onEvent(sessionId,{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'{"entries":[]}' }]}}});
      adapter.onEvent(sessionId,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
      return {result:{ok:true,value:{}}};
    };
    await adapter.extract([],[]);assert.equal(bridge.getCollectorCount(),1);
    const before=bridge.getModelCacheSizes().models;
    bridge.recordSessionSnapshot(bookSession,snapshot);
    assert.equal(bridge.getCollectorCount(),1);assert.equal(bridge.getModelCacheSizes().models,before);
  } finally {await bridge.close();}
});

test('bridge book collection precedes closed-mode filtering; onlyBooks guards stale sends and trusted queries', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const bridge = await bridgeHarness({ config: { ackMessage:'',sendDelayMs:0, bookbot:{ enabled:true,groups:['456'],onlyBooks:true } } });
  try {
    assert.ok(bridge.getBookbot(), 'bridge must initialize opt-in book worker');
    const event = (id,text) => ({ self_id:'9',group_id:'456',user_id:'20',message_id:id,message:[{type:'text',data:{text}}],time:Math.floor(Date.now()/1000) });
    bridge.setMode('closed-agent');
    await bridge.handleIncoming('group',456,event('1','毫无关键词的这本真好'),bridge.cfg);
    assert.equal(bridge.getBookbot().store.groups().length,1);
    assert.equal(bridge.calls.prompts.length,0);
    bridge.setMode('chat');
    await bridge.sendToQQ('group:456','旧聊天回复');
    assert.equal(bridge.calls.sent.length,0);
    await assert.rejects(bridge.ensureSession('group:456'), /书单|book|only/i);
    await bridge.handleIncoming('group',456,event('2','/书单 今天'),bridge.cfg);
    assert.equal(bridge.calls.sent.length,1);
    assert.match(bridge.calls.sent[0].text,/0 本/);
    const authorized = bridge.captureSendGuard('group:456',{bookbotQuery:true});
    bridge.cfg.bookbot.groups=[];
    assert.throws(authorized,/发送|授权|书单/);
    bridge.cfg.bookbot.groups=['456'];
    bridge.setMode('closed-agent');
    const closedGuard = bridge.captureSendGuard('group:456',{bookbotQuery:true});
    assert.throws(closedGuard,/发送/);
  } finally { await bridge.close(); }
});

test('disabled bookbot keeps existing generic session and send behavior', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const bridge = await bridgeHarness({config:{sendDelayMs:0,bookbot:{enabled:false,groups:['456'],onlyBooks:true}}});
  try {
    bridge.setMode('chat');
    assert.equal(bridge.getBookbot(),null);
    await bridge.ensureSession('group:456');
    await bridge.sendToQQ('group:456','正常聊天');
    assert.equal(bridge.calls.created.length,1);
    assert.equal(bridge.calls.sent.length,1);
  } finally { await bridge.close(); }
});

test('switching onlyBooks rejects cached generic MCP tokens for reads and mutations without reconciliation', async () => {
  const {bridgeHarness}=await import('./audit-bridge-harness.mjs');let handler;
  const fakeHttp={createServer(fn){
    handler=fn;const server=new EventEmitter();
    server.listen=(_port,_host,ready)=>{ready();return server;};server.address=()=>({port:3100});return server;
  }};
  const bridge=await bridgeHarness({config:{sendDelayMs:0,bookbot:{enabled:true,groups:['456'],onlyBooks:false}},globals:{http:fakeHttp}});
  const request=async(key,token,{route='/api/socialV2/state',body,marker=true}={})=>{
    const req=new EventEmitter();req.url=route+'?key='+encodeURIComponent(key);req.method=body===undefined?'GET':'POST';
    req.headers={host:'127.0.0.1:3100','x-console-token':'fixture-console-token','x-agent-token':token,...(marker?{'x-agent-call':'1'}:{})};
    if(body!==undefined)req.headers['content-type']='application/json';req.pause=()=>{};
    let status;let data;const res={writeHead(code){status=code;},end(text){data=JSON.parse(text);}};
    const pending=handler(req,res);
    if(body!==undefined){req.emit('data',JSON.stringify({key,...body}));req.emit('end');}
    await pending;return {status,data};
  };
  try {
    bridge.setMode('reserved2');await bridge.ensureSession('group:456');await bridge.ensureSession('private:123');
    const groupToken=bridge.getSocialV2State('group:456').agentToken;const privateToken=bridge.getSocialV2State('private:123').agentToken;
    bridge.startConsoleServer();
    assert.equal((await request('group:456',groupToken)).status,200);
    assert.equal((await request('private:123',privateToken)).status,200);
    bridge.cfg.bookbot.onlyBooks=true;
    assert.equal((await request('group:456',groupToken)).status,403,'central MCP admission must revoke cached book-only group token');
    assert.equal((await request('group:456',groupToken,{marker:false})).status,403,'endpoint token validation must also revoke it');
    assert.equal((await request('group:456',groupToken,{route:'/api/socialV2/feedback',body:{message:'stale mutation'}})).status,403);
    assert.equal((await request('private:123',privateToken)).status,200,'private generic token remains admitted');
    await bridge.handleIncoming('group',456,{self_id:'9',group_id:'456',user_id:'20',message_id:'query',message:'/书单 今天'},bridge.cfg);
    assert.equal(bridge.calls.sent.length,1,'trusted deterministic book query remains allowed');
    bridge.setMode('chat');
    assert.equal((await request('group:456',groupToken,{route:'/api/authorize/read',body:{token:groupToken},marker:false})).status,403,'cached token also stays blocked in first-generation mode');
    bridge.cfg.bookbot.onlyBooks=false;
    assert.equal((await request('group:456',groupToken,{route:'/api/authorize/read',body:{token:groupToken},marker:false})).status,200);
    bridge.setMode('reserved2');
    assert.equal((await request('group:456',groupToken,{route:'/api/socialV2/feedback',body:{message:'ordinary mutation'}})).status,200);
  } finally {await bridge.close();}
});

test('silent role keeps book collection but blocks query replies and queued query guards', async () => {
  const { bridgeHarness }=await import('./audit-bridge-harness.mjs');
  const bridge=await bridgeHarness({config:{sendDelayMs:0,bookbot:{enabled:true,groups:['456'],onlyBooks:true}}});
  try {
    bridge.setMode('chat');
    const guard=bridge.captureSendGuard('group:456',{bookbotQuery:true});
    guard();
    fs.writeFileSync(path.join(bridge.temp,'state/current-role.json'),JSON.stringify({role:null,mode:'silent'}));
    const event=(id,text)=>({self_id:'9',group_id:'456',user_id:'20',message_id:id,message:[{type:'text',data:{text}}],time:Math.floor(Date.now()/1000)});
    await bridge.handleIncoming('group',456,event('1','推荐星河，人物写得好'),bridge.cfg);
    assert.equal(bridge.getBookbot().store.groups().length,1);
    assert.equal(bridge.calls.prompts.length,0);
    await bridge.handleIncoming('group',456,event('2','/书单 今天'),bridge.cfg);
    assert.equal(bridge.calls.sent.length,0);
    assert.throws(guard,/静默/);
  } finally {await bridge.close();}
});

test('period/person query keeps matching recommendation visible after newer unrelated reviews', () => {
  const f=fixture();
  try {
    const add=(id,userId,kind,time) => {
      f.store.capture(message(id,'星河', {userId,name:'用户'+userId,time}));
      const batch=f.store.claim('9','10',20,Date.now());
      f.store.complete(batch,[entry(id,{kind,evidence:'星河',wordCount:null,status:null})]);
    };
    const now=Date.parse('2026-10-10T03:00:00Z');
    add('old','21','recommend',now-86400000);
    add('today','20','recommend',now-60000);
    for(let i=0;i<6;i++) add('r'+i,'21','review',now-1000+i);
    const today=botModule.renderBookQuery(f.store.query('9','10',{type:'period',value:'today'},now));
    assert.match(today,/本次查询推荐人：.*20/);
    const user=botModule.renderBookQuery(f.store.query('9','10',{type:'user',value:'20'},now));
    assert.match(user,/本次查询推荐人：.*20/);
    assert.match(user,/本群首次记录：.*21/);
  } finally { f.close(); }
});

test('retention clears non-book raw text but keeps pending work, source evidence and dedup tombstones', () => {
  const f=fixture();
  try {
    f.store.capture(message('1','普通闲聊',{time:1}));
    f.store.complete(f.store.claim('9','10',10,Date.now()),[]);
    f.store.capture(message('2','星河好看，120万字，连载',{time:1}));
    f.store.complete(f.store.claim('9','10',10,Date.now()),[entry('2')]);
    f.store.capture(message('3','待处理文本',{time:1}));
    assert.equal(f.store.prune(Date.now()),1);
    assert.equal(f.store.capture(message('1','重复普通闲聊')),false);
    const batch=f.store.claim('9','10',10,Date.now());
    assert.equal(batch[0].text,'待处理文本');
    assert.equal(f.store.context(batch,10,10000).some(m=>m.messageId==='2'),true);
    assert.equal(f.store.context(batch,10,10000).some(m=>m.messageId==='1'),false);
  } finally { f.close(); }
});

test('stop drains current extraction without starting later group work or committing its result', async () => {
  const f=fixture(); let release; let started;
  const ready=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{release=resolve;}); let calls=0;
  const cfg={allow:{groups:['10','11']},bookbot:{enabled:true,groups:['10','11']}};
  const bot=new botModule.Bookbot({store:f.store,getConfig:()=>cfg,send:async()=>{},extract:async()=>{calls++;started();await gate;return {entries:[]};}});
  try {
    f.store.capture(message('1','待处理'));
    f.store.capture(message('2','另一个群',{groupId:'11'}));
    const flush=bot.flush({force:true});await ready;
    const stopping=bot.stop();release();await Promise.all([flush,stopping]);
    assert.equal(calls,1);
    assert.equal(f.store.groups().length,2);
  } finally { await bot.stop();f.close(); }
});

test('latest wordcount/status snapshots survive newer reviews and withdrawal falls back or clears each field', () => {
  const f=fixture();const now=Date.parse('2026-10-10T03:00:00Z');
  const add=(id,userId,text,wordCount,status,offset)=>{
    f.store.capture(message(id,text,{userId,name:'用户'+userId,time:now+offset}));
    const batch=f.store.claim('9','10',10,Date.now());
    f.store.complete(batch,[entry(id,{kind:id==='old'?'recommend':'review',opinion:'个人评价',tags:[],evidence:text,wordCount,status})]);
  };
  const query=()=>f.store.query('9','10',{type:'title',value:'星河'},now+10000);
  try {
    add('old','20','星河100万字，连载','100万字','连载',0);
    add('words','21','星河120万字','120万字',null,1000);
    add('status','22','星河已完结',null,'已完结',2000);
    for(let i=0;i<6;i++)add('review'+i,'23','星河节奏不错',null,null,3000+i);
    const result=query();const rendered=botModule.renderBookQuery(result);
    assert.match(rendered,/群友报告字数：120万字.*用户21.*消息 words/);
    assert.match(rendered,/群友报告状态：已完结.*用户22.*消息 status/);
    assert.equal(result.books[0].wordCountReport.time,now+1000);
    assert.equal(result.books[0].statusReport.time,now+2000);
    assert.equal(result.books[0].entries.every(e=>e.wordCount===null&&e.status===null),true);
    assert.equal(f.store.cancel('9','10','words','21','123').ok,true);
    let fallback=query();
    assert.equal(fallback.books[0].wordCountReport.value,'100万字');
    assert.equal(fallback.books[0].wordCountReport.messageId,'old');
    assert.equal(fallback.books[0].statusReport.value,'已完结');
    assert.equal(f.store.cancel('9','10','status','22','123').ok,true);
    fallback=query();assert.equal(fallback.books[0].statusReport.value,'连载');
    assert.equal(f.store.cancel('9','10','old','20','123').ok,true);
    const cleared=query();
    assert.equal(cleared.books[0].wordCountReport,null);assert.equal(cleared.books[0].statusReport,null);
    assert.doesNotMatch(botModule.renderBookQuery(cleared),/群友报告字数：|群友报告状态：/);
    assert.ok(rendered.length<=3500);
  } finally {f.close();}
});

function longBookResult(f,{manyRecommenders=false}={}) {
  const now=Date.parse('2026-10-10T03:00:00Z');let offset=0;
  const tags=Array.from({length:12},(_,i)=>'标签'+i+'长'.repeat(25));
  const opinion='个人讨论'.repeat(125);
  const add=(id,userId,kind,extras={})=>{
    const e=entry(id,{kind,tags,opinion,wordCount:null,status:null,...extras});
    const text=['星河',opinion,...tags,e.wordCount,e.status].filter(Boolean).join('，');e.evidence=text.slice(0,900);
    f.store.capture(message(id,text,{userId,name:id.startsWith('rec')&&manyRecommenders?'推荐者'.repeat(60):'用户'+userId,time:now+offset++}));
    const batch=f.store.claim('9','10',10,Date.now());
    f.store.complete(batch,extractModule.validateExtraction({entries:[e]},batch,[]));
  };
  for(let i=0;i<(manyRecommenders?6:1);i++)add('rec'+i,String(20+i),'recommend');
  add('words','30','review',{wordCount:'120万字'});add('status','31','review',{status:'已完结'});
  for(let i=0;i<4;i++)add('review'+i,'40','review');
  return f.store.query('9','10',{type:'title',value:'星河'},now+1000);
}

test('small reply budget retains the matching title and source-labelled reports while omitting long discussions', () => {
  const f=fixture();
  try {
    const reply=botModule.renderBookQuery(longBookResult(f),500);
    assert.ok(reply.length<=500);assert.match(reply,/《星河》/);assert.doesNotMatch(reply,/仅展示 0\/1/);
    assert.match(reply,/本次查询推荐人：.*20/);
    assert.match(reply,/群友报告字数：120万字.*30.*2026.*消息 words/);
    assert.match(reply,/群友报告状态：已完结.*31.*2026.*消息 status/);
    assert.match(reply,/省略/);
  } finally {f.close();}
});

test('default reply budget shows a large valid book result instead of dropping the whole book', () => {
  const f=fixture();
  try {
    const reply=botModule.renderBookQuery(longBookResult(f,{manyRecommenders:true}));
    assert.ok(reply.length<=3500);assert.match(reply,/《星河》/);assert.doesNotMatch(reply,/仅展示 0\/1/);
    assert.match(reply,/本次查询推荐人：.*20/);assert.match(reply,/群友报告字数：120万字.*消息 words/);
    assert.match(reply,/群友报告状态：已完结.*消息 status/);assert.match(reply,/省略/);
  } finally {f.close();}
});
