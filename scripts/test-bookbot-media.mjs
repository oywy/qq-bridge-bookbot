import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {BookbotStore} from '../src/bookbot-store.js';
import {Bookbot,renderBookQuery} from '../src/bookbot.js';
import {validateExtraction,DshBookExtractor} from '../src/bookbot-extractor.js';
import {createTurnCollector,NodeApiClient} from '../src/dsh-client.js';
const mediaModule=await import('../src/bookbot-media.js').catch(()=>({}));
const now=Date.parse('2026-10-10T03:00:00Z');
const cfg=()=>({allow:{groups:['10']},bookbot:{enabled:true,groups:['10'],onlyBooks:true,retryMs:1}});
const event=(id,segments,user='20',group='10')=>({self_id:'9',group_id:group,user_id:user,message_id:id,time:now/1000,sender:{nickname:'分享者'},message:segments});
const text=s=>({type:'text',data:{text:s}}), image=file=>({type:'image',data:{file}}), voice=()=>({type:'record',data:{file:'DO-NOT-FETCH',url:'http://127.0.0.1/private'}});
const entry=(id,extra={})=>({sourceId:id,title:'星河',author:null,kind:'mention',tags:[],opinion:null,wordCount:null,status:null,evidence:'星河',...extra});
function fixture(options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'book-media-'));
  const store=new BookbotStore(path.join(dir,'books.sqlite'));
  const config=cfg();
  const bot=new Bookbot({store,getConfig:()=>config,now:()=>now,extract:async()=>({entries:[]}),send:async()=>{},...options});
  return {dir,store,bot,config,async close(){await bot.stop();
      store.close();
      fs.rmSync(dir,{recursive:true,force:true});
  }};
}
test('authorized pure image and record sources are captured with original identity, group isolation and dedup',async()=>{
  const f=fixture();
  try{
    await f.bot.handle(event('i',[image('safe.png')]));
    await f.bot.handle(event('v',[voice()]));
    await f.bot.handle(event('i',[image('duplicate.png')]));
    await f.bot.handle(event('self',[image('x')],'9'));
    await f.bot.handle(event('other',[voice()],'20','11'));
    const batch=f.store.claim('9','10',10,now);
    assert.equal(batch.length,2,'pure media must enter durable queue');
    assert.equal(batch[0].text,'');
    assert.equal(batch[0].userId,'20');
    assert.deepEqual(batch[0].media.images,[{kind:'image',file:'safe.png'}]);
    assert.equal(batch[1].media.voice,true);
    assert.equal(JSON.stringify(batch[1].media).includes('DO-NOT-FETCH'),false);
  }finally{await f.close();
  }
});

test('disabled media channels leave Markdown captions processable and ignore pure media',async()=>{
  const f=fixture();
  f.config.bookbot.media={images:false,voice:false};
  try{
    await f.bot.handle(event('caption',[image('x'),voice(),{type:'markdown',data:{content:'推荐星河'}}]));
    await f.bot.handle(event('pure',[image('x'),voice()]));
    const batch=f.store.claim('9','10',10,now);
    assert.equal(batch.length,1);
    assert.equal(batch[0].text,'推荐星河');
    assert.deepEqual(batch[0].media,{images:[],voice:false});
  }finally{await f.close();
  }
});

test('populated legacy SQLite migrates idempotently without losing text, entries or dedup',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'book-old-'));
  const file=path.join(dir,'b.sqlite');
  let store;
  try{
    const db=new DatabaseSync(file);
    db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY,accountId TEXT,groupId TEXT,messageId TEXT,userId TEXT,name TEXT,text TEXT,time INTEGER,quoteId TEXT,state TEXT,attempts INTEGER DEFAULT 0,retryAt INTEGER DEFAULT 0,UNIQUE(accountId,groupId,messageId));CREATE TABLE books(id INTEGER PRIMARY KEY,accountId TEXT,groupId TEXT,title TEXT,author TEXT,titleKey TEXT,authorKey TEXT,UNIQUE(accountId,groupId,titleKey,authorKey));CREATE TABLE entries(id INTEGER PRIMARY KEY,source INTEGER,book INTEGER,kind TEXT,tags TEXT,opinion TEXT,wordCount TEXT,status TEXT,evidence TEXT,UNIQUE(source,book,kind));INSERT INTO messages VALUES(1,'9','10','old','20','甲','推荐星河',1,NULL,'done',0,0);INSERT INTO books VALUES(1,'9','10','星河',NULL,'星河','');INSERT INTO entries VALUES(1,1,1,'recommend','[]',NULL,NULL,NULL,'推荐星河');`);
    db.close();
    store=new BookbotStore(file);
    assert.equal(store.query('9','10',{type:'title',value:'星河'}).books[0].entries[0].evidenceOrigin,'text');
    store.close();
    store=new BookbotStore(file);
    assert.equal(store.capture({accountId:'9',groupId:'10',messageId:'old',userId:'20',text:'replay',time:now}),false);
  }finally{store?.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('image proof is mention-only; captions and voice may recommend while metadata retains its own channel',async()=>{
  const f=fixture();
  try{
    await f.bot.handle(event('i',[image('i.png')]));
    let batch=f.store.claim('9','10',10,now);
    batch[0].recognition={images:[{index:1,text:'推荐星河，120万字，完结'}]};
    assert.throws(()=>validateExtraction({entries:[entry('i',{kind:'recommend',evidence:'推荐星河'})]},batch),/image|图片/i);
    assert.throws(()=>validateExtraction({entries:[entry('i',{opinion:'好看'})]},batch),/image|图片/i);
    f.store.saveRecognition(batch[0],{images:batch[0].recognition.images});
    f.store.complete(batch,validateExtraction({entries:[entry('i',{wordCount:'120万字',status:'完结'})]},batch));
    assert.equal(f.store.query('9','10',{type:'title',value:'星河'}).recommenders,0);
    assert.equal(f.store.query('9','10',{type:'period',value:'today'},now).totalBooks,0);
    await f.bot.handle(event('c',[text('推荐这本'),image('c.png')]));
    batch=f.store.claim('9','10',10,now);
    batch[0].recognition={images:[{index:1,text:'星河，130万字，连载'}]};
    f.store.saveRecognition(batch[0],batch[0].recognition);
    f.store.complete(batch,validateExtraction({entries:[entry('c',{kind:'recommend',evidence:'推荐这本',wordCount:'130万字',status:'连载'})]},batch));
    await f.bot.handle(event('v',[voice()],'21'));
    batch=f.store.claim('9','10',10,now);
    batch[0].recognition={voice:'推荐星河，140万字，完结'};
    f.store.saveRecognition(batch[0],batch[0].recognition);
    f.store.complete(batch,validateExtraction({entries:[entry('v',{kind:'recommend',evidence:'推荐星河',wordCount:'140万字',status:'完结'})]},batch));
    let result=f.store.query('9','10',{type:'title',value:'星河'},now);
    assert.equal(result.recommenders,2);
    assert.equal(result.books[0].wordCountReport.origin,'voice');
    assert.match(renderBookQuery(result),/QQ语音转写|QQ转写/);
    assert.match(renderBookQuery(result),/图片识别.*分享者/);
    f.store.cancel('9','10','v','21','');
    result=f.store.query('9','10',{type:'title',value:'星河'},now);
    assert.equal(result.books[0].wordCountReport.value,'130万字');
    assert.equal(result.books[0].wordCountReport.origin,'image');
    assert.match(renderBookQuery(result),/图片识别字数/);
  }finally{await f.close();
  }
});

test('successful channel recognition survives extraction failure and restart; recognized context resolves later text',async()=>{
  let images=0,voices=0,extracts=0;
  const f=fixture({recognizeImages:async()=>{images++;
      return {images:[{index:1,text:'星河'}]};
    },transcribeVoice:async()=>{voices++;
      return '这本真好';
    },extract:async batch=>{extracts++;
      if(extracts===1)throw Error('extract failure');
      return {entries:[entry(batch[0].messageId)]};
  }});
  try{
    await f.bot.handle(event('m',[image('x.png'),voice()]));
    await f.bot.flush({force:true});
    assert.equal(images,1);
    assert.equal(voices,1);
    await f.bot.stop();
    f.store.close();
    f.store=new BookbotStore(path.join(f.dir,'books.sqlite'));
    f.bot=new Bookbot({store:f.store,getConfig:()=>f.config,now:()=>now+10,recognizeImages:async()=>{images++;
        throw Error('should cache');
      },transcribeVoice:async()=>{voices++;
        throw Error('should cache');
      },extract:async batch=>({entries:[entry(batch[0].messageId)]}),send:async()=>{}});
    await f.bot.flush({force:true});
    assert.equal(images,1);
    assert.equal(voices,1);
    assert.equal(f.store.query('9','10',{type:'title',value:'星河'}).totalBooks,1);
    await f.bot.handle(event('next',[text('推荐这本')]));
    const batch=f.store.claim('9','10',10,now+10);
    const context=f.store.context(batch);
    assert.equal(context[0].recognition.images[0].text,'星河');
    assert.doesNotThrow(()=>validateExtraction({entries:[entry('next',{kind:'recommend',evidence:'推荐这本'})]},batch,context));
  }finally{await f.bot.stop();
    f.store.close();
    fs.rmSync(f.dir,{recursive:true,force:true});
  }
});

test('a failed media channel only retries its source and caches the successful other channel',async()=>{
  let images=0,voiceCalls=0;
  let allow=false;
  const batches=[];
  const f=fixture({recognizeImages:async()=>{images++;
      return {images:[{index:1,text:'星河'}]};
    },transcribeVoice:async()=>{voiceCalls++;
      if(!allow)throw Error('not ready');
      return '星河';
    },extract:async batch=>{batches.push(batch.map(m=>m.messageId));
      return {entries:[]};
  }});
  try{await f.bot.handle(event('bad',[image('x'),voice()]));
    await f.bot.handle(event('text',[text('天色很好')]));
    await f.bot.flush({force:true});
    assert.deepEqual(batches,[['text']]);
    assert.equal(f.store.db.prepare("SELECT state FROM messages WHERE messageId='bad'").get().state,'pending');
    allow=true;
    f.bot.now=()=>now+10;
    await f.bot.flush({force:true});
    assert.equal(images,1);
    assert.equal(voiceCalls,2);
    assert.deepEqual(batches,[['text'],['bad']]);
  }finally{await f.close();
  }
});

test('recognition never executes commands and withdrawal during recognition erases all caches permanently',async()=>{
  let unblock;
  const started=new Promise(resolve=>{unblock=resolve;
  });

  let release;
  const result=new Promise(resolve=>{release=resolve;
  });

  let sends=0;
  const f=fixture({recognizeImages:async()=>{unblock();
      return result;
    },send:async()=>{sends++;
  }});
  try{await f.bot.handle(event('i',[image('x')]));
    const flush=f.bot.flush({force:true});
    await started;
    assert.equal(f.store.cancel('9','10','i','20','').ok,true);
    release({images:[{index:1,text:'/书单 今天'}]});
    await flush;
    const row=f.store.db.prepare("SELECT * FROM messages WHERE messageId='i'").get();
    assert.equal(row.state,'cancelled');
    assert.equal(row.text,'');
    assert.equal(row.media,'{}');
    assert.equal(row.recognition,'{}');
    assert.equal(sends,0);
    assert.equal(f.store.capture({accountId:'9',groupId:'10',messageId:'i',userId:'20',text:'replay',time:now}),false);
  }finally{await f.close();
  }
  const second=fixture({transcribeVoice:async()=>'/书单 撤销',extract:async()=>({entries:[]}),send:async()=>{sends++;
  }});
  try{await second.bot.handle(event('v',[voice()]));
    await second.bot.flush({force:true});
    assert.equal(sends,0);
  }finally{await second.close();
  }
});

test('retention removes recognized nonbook caches but keeps pending/book proof and tombstones',async()=>{
  const f=fixture();
  try{for(const id of ['done','proof','pending'])await f.bot.handle(event(id,[image('x')]));
    let batch=f.store.claim('9','10',2,now);
    for(const m of batch){m.recognition={images:[{index:1,text:'星河'}]};
      f.store.saveRecognition(m,m.recognition);
    }f.store.complete(batch,validateExtraction({entries:[entry('proof')]},batch));
    assert.equal(f.store.prune(now+1),1);
    let row=f.store.db.prepare("SELECT * FROM messages WHERE messageId='done'").get();
    assert.equal(row.media,'{}');
    assert.equal(row.recognition,'{}');
    assert.notEqual(f.store.db.prepare("SELECT recognition FROM messages WHERE messageId='proof'").get().recognition,'{}');
    assert.equal(f.store.db.prepare("SELECT state FROM messages WHERE messageId='pending'").get().state,'pending');
  }finally{await f.close();
  }
});

test('OCR shape accepts empty visible text but rejects partial, extra, oversized and malformed results',()=>{
  assert.equal(typeof mediaModule.validateImageRecognition,'function');
  const valid=mediaModule.validateImageRecognition;
  assert.deepEqual(valid({images:[{index:1,text:''}]},1),[{index:1,text:''}]);
  for(const value of [{images:[]},{images:[{index:2,text:'x'}]},{images:[{index:1,text:'x',url:'no'}]},{images:[{index:1,text:'x'.repeat(12001)}]},{images:[{index:1,text:3}]},{images:[{index:1,text:'x'}],extra:true}])assert.throws(()=>valid(value,1));
  assert.throws(()=>valid({images:[]},6));
});

test('QQ transcription uses the configured HTTP endpoint/token and source ID; malformed/empty/timeout fail closed',async()=>{
  assert.equal(typeof mediaModule.fetchQqVoiceText,'function');
  const config={snowluma:{httpUrl:'http://fixture.invalid/gateway/',accessToken:'fixture-secret'}};
  let calls=0;
  const fetch=async(url,init)=>{calls++;
    assert.equal(url,'http://fixture.invalid/gateway/fetch_ptt_text');
    assert.equal(init.headers.authorization,'Bearer fixture-secret');
    assert.deepEqual(JSON.parse(init.body),{message_id:'123'});
    assert.ok(init.signal);
    return {ok:true,json:async()=>({status:'ok',retcode:0,data:{text:'推荐星河'}})};
  };
  assert.equal(await mediaModule.fetchQqVoiceText({messageId:123},config,{fetch}), '推荐星河');
  assert.equal(calls,1);
  for(const body of [{status:'ok',retcode:0,data:{text:''}},{status:'ok',retcode:0,data:{text:' '.repeat(10)}},{status:'ok',retcode:0,data:{text:'x'.repeat(12001)}},{status:'failed',retcode:0,data:{text:'x'}},{status:'ok',retcode:1,data:{text:'x'}},{status:'ok',retcode:0,data:{text:3}}])await assert.rejects(mediaModule.fetchQqVoiceText({messageId:'123'},config,{fetch:async()=>({ok:true,json:async()=>body})}));
  await assert.rejects(mediaModule.fetchQqVoiceText({messageId:'123'},config,{timeoutMs:5,fetch:async(_url,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('aborted'))))}));
});

test('OCR shares fresh preset sessions, inline images, forget-before-stop and selection/error/timeout/late-frame cleanup',async()=>{
  const api=new NodeApiClient('http://127.0.0.1:1');
  let adapter,count=0,mode='ok';
  const retired=[],stopped=[];
  const success=value=>({result:{ok:true,value}});
  api.callUnary=async(method,params)=>{if(method==='workspace.create')return success({workspace:{workspaceId:'w'}});
    if(method==='session.create'){assert.equal(params.agentPreset,'book-extractor');
      return success({sessionId:'ocr-'+(++count)});
    }if(method==='session.prompt'){assert.equal(api._desiredFollows.has(params.sessionId),true);
      assert.equal(params.content.filter(p=>p.type==='image').length,1);
      if(mode==='reject')return {result:{ok:false,error:{message:'rejected'}}};
      if(mode==='ok'){adapter.onEvent(params.sessionId,{type:'turn/start',data:{turn:1}});
        adapter.onEvent(params.sessionId,{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'{"images":[{"index":1,"text":"星河"}]}'}]}}});
        adapter.onEvent(params.sessionId,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
      }return success({});
    }return success({});
  };
  api.stopSessionWork=async id=>{stopped.push(id);
    assert.equal(api._desiredFollows.has(id),false);
  };
  adapter=new DshBookExtractor({api,createTurnCollector,resolvePreset:()=> 'book-extractor',workspacePath:os.tmpdir(),timeoutMs:10,onRetire:id=>retired.push(id),selectModel:async()=>{if(mode==='select')throw Error('selection failure');
  }});
  assert.equal(typeof adapter.recognizeImages,'function');
  const parts=[{type:'image',mediaType:'image/png',data:'fixture',name:'image.png'}];
  assert.deepEqual(await adapter.recognizeImages(parts),{images:[{index:1,text:'星河'}]});
  for(const next of ['reject','timeout','select']){mode=next;
    await assert.rejects(adapter.recognizeImages(parts));
    assert.equal(adapter.pending.size,0);
    assert.equal(adapter.onEvent('ocr-'+count,{type:'turn/start',data:{turn:99}}),false);
  }assert.equal(retired.length,4);
  assert.equal(stopped.length,4);
  assert.equal(api._desiredFollows.size,0);
});

test('real bridge reuses safe image gateway and voice HTTP while refusing partial/overlimit images',async()=>{
  const {bridgeHarness}=await import('./audit-bridge-harness.mjs');
  const bridge=await bridgeHarness({config:{snowluma:{httpUrl:'http://fixture.invalid',accessToken:'fixture-secret'},bookbot:{enabled:true,groups:['456'],onlyBooks:true}}});
  try{bridge.setPresets(['book-extractor']);
    const adapter=bridge.getBookExtractor();
    bridge.api.sessions.prompt=async params=>{const ocr=params.content.some(p=>p.type==='image');
      const out=ocr?{images:[{index:1,text:'星河'}]}:{entries:[]};
      adapter.onEvent(params.sessionId,{type:'turn/start',data:{turn:1}});
      adapter.onEvent(params.sessionId,{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:JSON.stringify(out)}]}}});
      adapter.onEvent(params.sessionId,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
      return {result:{ok:true,value:{}}};
    };
    const bot=bridge.getBookbot();
    await bot.handle({...event('image',[image('safe.png')]),group_id:'456'});
    await bot.handle({...event('voice',[voice()]),group_id:'456'});
    await bot.flush({force:true});
    assert.deepEqual(bridge.calls.images,['safe.png']);
    assert.equal(bridge.calls.http.filter(c=>c.url.endsWith('/fetch_ptt_text')).length,1);
    await bot.handle({...event('bad',[image('../secret')]),group_id:'456'});
    await bot.handle({...event('many',Array.from({length:6},()=>image('x'))),group_id:'456'});
    await bot.flush({force:true});
    assert.equal(bot.store.db.prepare("SELECT state FROM messages WHERE messageId='bad'").get().state,'pending');
    assert.equal(bot.store.db.prepare("SELECT state FROM messages WHERE messageId='many'").get().state,'pending');
    assert.equal(bridge.calls.images.includes('../secret'),false);
  }finally{await bridge.close();
  }
});

test('disabled current channels are excluded even when recognized cache exists; caption continues',async()=>{
  let attempts=0;
  const viewed=[];
  const f=fixture({recognizeImages:async()=>({images:[{index:1,text:'图片书'}]}),transcribeVoice:async()=> '语音书',extract:async batch=>{attempts++;
      viewed.push(batch[0]);
      if(attempts===1)throw Error('retry');
      return {entries:[]};
  }});
  try{await f.bot.handle(event('x',[text('原始文字'),image('x'),voice()]));
    await f.bot.flush({force:true});
    f.config.bookbot.media={images:false,voice:false};
    f.bot.now=()=>now+10;
    await f.bot.flush({force:true});
    assert.deepEqual(viewed[1].recognition,{},'disabled cached channels must not be model input');
    assert.equal(viewed[1].text,'原始文字');
    assert.ok(JSON.parse(f.store.db.prepare("SELECT recognition FROM messages WHERE messageId='x'").get().recognition).voice);
  }finally{await f.close();
  }
});

test('connection failure during model selection retires OCR immediately and ignores late frames',async()=>{
  let selected,release;
  const selecting=new Promise(resolve=>{selected=resolve;
  });

  const hold=new Promise(resolve=>{release=resolve;
  });

  let adapter;
  const retired=[];
  const success=value=>({result:{ok:true,value}});
  const api={workspace:{create:async()=>success({workspace:{workspaceId:'w'}}),archiveSession:async({sessionId})=>retired.push(sessionId)},sessions:{create:async()=>success({sessionId:'select-pending'}),prompt:async()=>success({})},events:{follow(){},forget(){}},stopSessionWork:async()=>{}};
  adapter=new DshBookExtractor({api,createTurnCollector,resolvePreset:()=> 'book-extractor',workspacePath:os.tmpdir(),timeoutMs:1000,selectModel:async()=>{selected();
      await hold;
  }});
  const running=adapter.recognizeImages([{type:'image',data:'fixture'}]);
  await selecting;
  adapter.failAll();
  await assert.rejects(Promise.race([running,new Promise((_,reject)=>setTimeout(()=>reject(Error('failure was not immediate')),50))]),/interrupted/);
  release();
  assert.deepEqual(retired,['select-pending']);
  assert.equal(adapter.onEvent('select-pending',{type:'turn/start',data:{turn:1}}),false);
});

test('revocation between image downloads prevents the next bridge adapter call and leaves source pending',async()=>{
  const {bridgeHarness}=await import('./audit-bridge-harness.mjs');
  let bridge;
  let count=0;
  class Bot{async getImage(){count++;
      bridge.cfg.deny.groups=['456'];
      return {base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII='};
  }}
  bridge=await bridgeHarness({config:{bookbot:{enabled:true,groups:['456']}},globals:{SnowLumaWebSocketClient:Bot}});
  try{const bot=bridge.getBookbot();
    await bot.handle({...event('x',[image('a'),image('b')]),group_id:'456'});
    await bot.flush({force:true});
    assert.equal(count,1);
    assert.equal(bot.store.db.prepare("SELECT state FROM messages WHERE messageId='x'").get().state,'pending');
    assert.equal(bridge.calls.prompts.length,0);
  }finally{await bridge.close();
  }
});

test('protected image loading rejects partial results, byte overflow and pixel overflow before OCR',async()=>{
  const {bridgeHarness}=await import('./audit-bridge-harness.mjs');
  let bridge;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=','base64');
  class Bot{async getImage({file}){if(file==='missing')return {};
      if(file==='big')return {base64:Buffer.concat([png,Buffer.alloc(3*1024*1024)]).toString('base64')};
      if(file==='pixels'){const data=Buffer.from(png);
        data.writeUInt32BE(100000,16);
        data.writeUInt32BE(100000,20);
        return {base64:data.toString('base64')};
      }return {base64:png.toString('base64')};
  }}
  bridge=await bridgeHarness({config:{bookbot:{enabled:true,groups:['456']}},globals:{SnowLumaWebSocketClient:Bot}});
  try{const bot=bridge.getBookbot();
    for(const [id,refs]of [['partial',['ok','missing']],['bytes',['big','big']],['pixels',['pixels']]])await bot.handle({...event(id,refs.map(image)),group_id:'456'});
    await bot.flush({force:true});
    assert.equal(bridge.calls.prompts.length,0);
    assert.deepEqual(bot.store.db.prepare('SELECT state FROM messages ORDER BY id').all().map(m=>m.state),['pending','pending','pending']);
  }finally{await bridge.close();
  }
});

test('real bridge model selection failure keeps media pending with no fallback prompt or cache',async()=>{
  const {bridgeHarness}=await import('./audit-bridge-harness.mjs');
  const bridge=await bridgeHarness({config:{bookbot:{enabled:true,groups:['456']}}});
  try{
    bridge.setPresets(['book-extractor']);
    bridge.api.sessions.selectModel=async()=>({result:{ok:false,error:{message:'fixture-model-private-error'}}});
    const adapter=bridge.getBookExtractor();
    bridge.api.sessions.prompt=async params=>{bridge.calls.prompts.push(params);
      adapter.onEvent(params.sessionId,{type:'turn/start',data:{turn:1}});
      adapter.onEvent(params.sessionId,{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'{"images":[{"index":1,"text":""}]}'}]}}});
      adapter.onEvent(params.sessionId,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
      return {result:{ok:true,value:{}}};
    };
    const bot=bridge.getBookbot();
    await bot.handle({...event('x',[image('x')]),group_id:'456'});
    await bot.flush({force:true});
    assert.equal(bridge.calls.prompts.length,0,'failed selection must not run under fallback model');
    assert.equal(bot.store.db.prepare("SELECT state FROM messages WHERE messageId='x'").get().state,'pending');
    assert.equal(bridge.getModelCacheSizes().applied,0);
    assert.equal(bridge.getModelCacheSizes().models,0);
  }finally{await bridge.close();
  }
});

test('a successful session-create acknowledgement after OCR timeout is retired exactly once',async()=>{
  const calls=[];
  let release;
  const ack=new Promise(resolve=>{release=resolve;
  });

  const success=value=>({result:{ok:true,value}});
  const api={workspace:{create:async()=>success({workspace:{workspaceId:'w'}}),archiveSession:async({sessionId})=>calls.push('archive:'+sessionId)},sessions:{create:()=>ack,prompt:async()=>{throw Error('must not prompt');
    }},events:{follow(){throw Error('must not follow');
      },forget:id=>calls.push('forget:'+id)},stopSessionWork:async id=>calls.push('stop:'+id)};
  const adapter=new DshBookExtractor({api,createTurnCollector,resolvePreset:()=> 'book-extractor',workspacePath:os.tmpdir(),timeoutMs:5,onRetire:id=>calls.push('retire:'+id)});
  await assert.rejects(adapter.recognizeImages([{type:'image',data:'fixture'}]),/timeout/);
  release(success({sessionId:'late'}));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(calls,['forget:late','stop:late','archive:late','retire:late']);
  assert.equal(adapter.pending.size,0);
});

test('connection failure during session creation retires a late session without prompting',async()=>{
  let release,started;
  const begun=new Promise(resolve=>{started=resolve;
  });

  const hold=new Promise(resolve=>{release=resolve;
  });

  const calls=[];
  const success=value=>({result:{ok:true,value}});
  const api={workspace:{create:async()=>success({workspace:{workspaceId:'w'}}),archiveSession:async({sessionId})=>calls.push('archive:'+sessionId)},sessions:{create:()=>{started();
        return hold;
      },prompt:async()=>{calls.push('prompt');
    }},events:{follow:()=>calls.push('follow'),forget:id=>calls.push('forget:'+id)},stopSessionWork:async id=>calls.push('stop:'+id)};
  const adapter=new DshBookExtractor({api,createTurnCollector,resolvePreset:()=> 'book-extractor',workspacePath:os.tmpdir(),timeoutMs:1000,onRetire:id=>calls.push('retire:'+id)});
  const running=adapter.recognizeImages([{type:'image',data:'fixture'}]);
  await begun;
  adapter.failAll();
  await assert.rejects(Promise.race([running,new Promise((_,reject)=>setTimeout(()=>reject(Error('not immediate')),50))]),/interrupted/);
  release(success({sessionId:'late-failure'}));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(calls,['forget:late-failure','stop:late-failure','archive:late-failure','retire:late-failure']);
});

test('caption evidence cannot launder screenshot opinion; explicit caption and voice opinions remain usable',()=>{
  const source={id:1,accountId:'9',groupId:'10',messageId:'x',text:'推荐这本',media:{images:[{kind:'image',file:'x'}]},recognition:{images:[{index:1,text:'星河很好看'}]}};
  assert.throws(()=>validateExtraction({entries:[entry('x',{kind:'recommend',evidence:'推荐这本',opinion:'很好看'})]},[source]),/image|图片/i);
  source.text='推荐这本，人物写得好';
  assert.doesNotThrow(()=>validateExtraction({entries:[entry('x',{kind:'recommend',evidence:'推荐这本',opinion:'人物写得好'})]},[source]));
  source.text='推荐这本';source.recognition.voice='我觉得人物写得好';
  assert.doesNotThrow(()=>validateExtraction({entries:[entry('x',{kind:'recommend',evidence:'推荐这本',opinion:'人物写得好'})]},[source]));
});
test('disabled cached voice cannot relabel current image metadata provenance',async()=>{
  let attempts=0;
  const f=fixture({recognizeImages:async()=>({images:[{index:1,text:'星河，连载'}]}),transcribeVoice:async()=> '连载',extract:async batch=>{if(++attempts===1)throw Error('retry');return {entries:[entry(batch[0].messageId,{status:'连载'})]};}});
  try {
    await f.bot.handle(event('x',[image('x'),voice()]));
    await f.bot.flush({force:true});
    f.config.bookbot.media={images:true,voice:false};f.bot.now=()=>now+10;
    await f.bot.flush({force:true});
    assert.equal(f.store.query('9','10',{type:'title',value:'星河'}).books[0].statusReport.origin,'image');
  } finally {await f.close();}
});
for (const channel of ['voice','images']) {
  test(`disabled ${channel} cache in pending context cannot prove a later quoted recommendation`,async()=>{
    let current=now;const contexts=[];
    const f=fixture({now:()=>current,recognizeImages:async()=>({images:[{index:1,text:'星河'}]}),transcribeVoice:async()=> '星河',extract:async(batch,context)=>{
      if(batch.some(m=>m.messageId==='earlier'))throw Error('retry extraction');
      contexts.push(context);return {entries:[entry('later',{kind:'recommend',evidence:'推荐这本'})]};
    }});
    f.config.bookbot.retryMs=60000;
    try {
      await f.bot.handle(event('earlier',channel==='voice'?[voice()]:[image('safe.png')]));
      await f.bot.flush({force:true});
      f.config.bookbot.media=channel==='voice'?{images:true,voice:false}:{images:false,voice:'qq'};
      current+=1000;
      await f.bot.handle(event('later',[{type:'reply',data:{id:'earlier'}},text('推荐这本')]));
      await f.bot.flush({force:true});
      assert.equal(f.store.query('9','10',{type:'title',value:'星河'}).totalBooks,0,'disabled pending cache must not establish the title');
      assert.equal(contexts.length,1);
      assert.equal(contexts[0][0]?.recognition[channel],undefined);
      assert.ok(JSON.parse(f.store.db.prepare("SELECT recognition FROM messages WHERE messageId='earlier'").get().recognition)[channel],'filter must not erase durable cache');
    } finally {await f.close();}
  });
}

test('disabled pending media context retains original caption and completed media context remains historical proof',async()=>{
  let current=now;const contexts=[];
  const f=fixture({now:()=>current,recognizeImages:async()=>({images:[{index:1,text:'图片书'.repeat(1000)}]}),transcribeVoice:async()=> '语音书'.repeat(1000),extract:async(batch,context)=>{
    if(batch.some(m=>m.messageId==='caption'))throw Error('retry extraction');
    contexts.push(context);return {entries:[entry(batch[0].messageId,{kind:'recommend',evidence:'推荐这本'})]};
  }});
  f.config.bookbot.retryMs=60000;f.config.bookbot.contextChars=10;
  try {
    await f.bot.handle(event('caption',[text('星河'),image('safe.png'),voice()]));
    await f.bot.flush({force:true});
    f.config.bookbot.media={images:false,voice:false};current+=1000;
    await f.bot.handle(event('later',[{type:'reply',data:{id:'caption'}},text('推荐这本')]));
    await f.bot.flush({force:true});
    assert.equal(f.store.query('9','10',{type:'title',value:'星河'}).recommenders,1);
    assert.equal(contexts[0][0].text,'星河');assert.deepEqual(contexts[0][0].recognition,{});
    f.config.bookbot.media={images:true,voice:'qq'};
    await f.bot.handle(event('historical',[image('safe.png')]));
    const historical=f.store.claim('9','10',10,current);
    f.store.saveRecognition(historical[0],{images:[{index:1,text:'历史书'}]});f.store.complete(historical,[]);
    f.config.bookbot.media={images:false,voice:false};
    await f.bot.handle(event('future',[{type:'reply',data:{id:'historical'}},text('推荐这本')]));
    const future=f.store.claim('9','10',10,current);
    const context=f.store.context(future,30,12000,{images:false,voice:false});
    assert.equal(context.find(m=>m.messageId==='historical').recognition.images[0].text,'历史书');
    assert.doesNotThrow(()=>validateExtraction({entries:[entry('future',{title:'历史书',kind:'recommend',evidence:'推荐这本'})]},future,context));
  } finally {await f.close();}
});
test('a channel switch during a later source preparation filters the whole batch with one fresh policy',async()=>{
  let f;let analyzed;
  f=fixture({recognizeImages:async()=>({images:[{index:1,text:'星河'}]}),transcribeVoice:async()=>{
    f.config.bookbot.media={images:false,voice:'qq'};return '另一条语音';
  },extract:async(batch,context)=>{analyzed={batch,context};return {entries:[]};}});
  try {
    f.store.capture({accountId:'9',groupId:'10',messageId:'context',userId:'20',name:'甲',text:'原始上下文',time:now,media:{images:[{kind:'image',file:'context.png'}]}});
    const cached=f.store.claim('9','10',10,now);
    f.store.saveRecognition(cached[0],{images:[{index:1,text:'缓存图片书'}]});f.store.retry(cached,now+60000);
    await f.bot.handle(event('first',[text('推荐这本'),image('first.png')]));
    await f.bot.handle(event('second',[voice()]));
    await f.bot.flush({force:true});
    assert.equal(analyzed.batch[0].recognition.images,undefined,'earlier source must obey policy changed while preparing later source');
    assert.equal(analyzed.batch[0].text,'推荐这本');
    assert.equal(analyzed.batch[1].recognition.voice,'另一条语音');
    assert.equal(analyzed.context.find(m=>m.messageId==='context').recognition.images,undefined,'context must use the same fresh media policy');
    assert.ok(JSON.parse(f.store.db.prepare("SELECT recognition FROM messages WHERE messageId='first'").get().recognition).images,'fresh filtering must retain durable OCR cache');
  } finally {await f.close();}
});
test('a channel enabled during later preparation defers only the source missing that recognition',async()=>{
  let f;let imageCalls=0;const batches=[];
  f=fixture({recognizeImages:async()=>{imageCalls++;return {images:[{index:1,text:'星河'}]};},transcribeVoice:async()=>{
    f.config.bookbot.media={images:true,voice:'qq'};return '另一条语音';
  },extract:async batch=>{batches.push(batch.map(m=>m.messageId));return {entries:[]};}});
  try {
    await f.bot.handle(event('first',[text('原始配文'),image('first.png')]));await f.bot.handle(event('second',[voice()]));
    f.config.bookbot.media={images:false,voice:'qq'};
    await f.bot.flush({force:true});
    assert.deepEqual(batches,[['second']],'newly enabled channel must be prepared before committing its source');
    assert.equal(f.store.db.prepare("SELECT state FROM messages WHERE messageId='first'").get().state,'pending');assert.equal(imageCalls,0);
    f.bot.now=()=>now+10;await f.bot.flush({force:true});
    assert.deepEqual(batches,[['second'],['first']]);assert.equal(imageCalls,1);
  } finally {await f.close();}
});

test('authorization revoked while preparing a later source prevents any prepared-source extraction',async()=>{
  let f;let extracts=0;
  f=fixture({recognizeImages:async()=>({images:[{index:1,text:'星河'}]}),transcribeVoice:async()=>{
    f.config.deny={groups:['10']};return '另一条语音';
  },extract:async()=>{extracts++;return {entries:[]};}});
  try {
    await f.bot.handle(event('first',[image('first.png')]));await f.bot.handle(event('second',[voice()]));
    await f.bot.flush({force:true});assert.equal(extracts,0,'revoked group must not hand earlier prepared OCR to extraction');
    assert.deepEqual(f.store.db.prepare('SELECT state FROM messages ORDER BY id').all().map(m=>m.state),['pending','pending']);
  } finally {await f.close();}
});

test('withdrawal while preparing a later source removes earlier in-memory OCR from pending proof',async()=>{
  let f;let analyzed;
  f=fixture({recognizeImages:async()=>({images:[{index:1,text:'星河'}]}),transcribeVoice:async()=>{
    assert.equal(f.store.cancel('9','10','first','20','').ok,true);return '推荐这本';
  },extract:async(batch,context)=>{analyzed={batch,context};return {entries:[entry('second',{kind:'recommend',evidence:'推荐这本'})]};}});
  try {
    await f.bot.handle(event('first',[image('first.png')]));await f.bot.handle(event('second',[voice()]));
    await f.bot.flush({force:true});assert.deepEqual(analyzed.batch.map(m=>m.messageId),['second'],'withdrawn source must not remain pending proof');
    assert.equal(analyzed.context.some(m=>m.messageId==='first'),false);
    assert.equal(f.store.query('9','10',{type:'title',value:'星河'}).totalBooks,0,'later reference cannot resolve using withdrawn OCR');
    const withdrawn=f.store.db.prepare("SELECT * FROM messages WHERE messageId='first'").get();assert.equal(withdrawn.state,'cancelled');assert.equal(withdrawn.recognition,'{}');
  } finally {await f.close();}
});
test('disabling voice during image preparation prevents a new QQ transcription handoff',async()=>{
  let f;let voiceCalls=0;let analyzed;
  f=fixture({recognizeImages:async()=>{f.config.bookbot.media={images:true,voice:false};return {images:[{index:1,text:'星河'}]};},transcribeVoice:async()=>{voiceCalls++;return '另一条语音';},extract:async batch=>{analyzed=batch;return {entries:[]};}});
  try {
    await f.bot.handle(event('mixed',[text('原始配文'),image('first.png'),voice()]));await f.bot.flush({force:true});
    assert.equal(voiceCalls,0,'disabled voice must not start a new adapter call');assert.equal(analyzed[0].recognition.voice,undefined);assert.equal(analyzed[0].text,'原始配文');
  } finally {await f.close();}
});

test('disabling images between protected downloads prevents the next call and continues the caption',async()=>{
  const {bridgeHarness}=await import('./audit-bridge-harness.mjs');let bridge;let downloads=0;
  class Bot {async getImage(){downloads++;bridge.cfg.bookbot.media.images=false;return {base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII='};}}
  bridge=await bridgeHarness({config:{bookbot:{enabled:true,groups:['456']}},globals:{SnowLumaWebSocketClient:Bot}});
  try {
    bridge.setPresets(['book-extractor']);const adapter=bridge.getBookExtractor();let prompts=0;
    bridge.api.sessions.prompt=async params=>{prompts++;assert.equal(params.content.some(part=>part.type==='image'),false,'disabled image must not start OCR');adapter.onEvent(params.sessionId,{type:'turn/start',data:{turn:1}});adapter.onEvent(params.sessionId,{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'{"entries":[]}'}]}}});adapter.onEvent(params.sessionId,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});return {result:{ok:true,value:{}}};};
    const bot=bridge.getBookbot();await bot.handle({...event('caption',[text('原始配文'),image('first.png'),image('second.png')]),group_id:'456'});await bot.flush({force:true});
    assert.equal(downloads,1,'channel-aware guard must prevent later protected image call');assert.equal(prompts,1);assert.equal(bot.store.db.prepare("SELECT state FROM messages WHERE messageId='caption'").get().state,'done');
  } finally {await bridge.close();}
});

test('stopping during later source preparation prevents an earlier prepared source handoff',async()=>{
  let f;let extracts=0;
  f=fixture({recognizeImages:async()=>({images:[{index:1,text:'星河'}]}),transcribeVoice:async()=>{f.bot.stopped=true;return '另一条语音';},extract:async()=>{extracts++;return {entries:[]};}});
  try {await f.bot.handle(event('first',[image('first.png')]));await f.bot.handle(event('second',[voice()]));await f.bot.flush({force:true});assert.equal(extracts,0);assert.deepEqual(f.store.db.prepare('SELECT state FROM messages ORDER BY id').all().map(m=>m.state),['pending','pending']);}finally{await f.close();}
});
