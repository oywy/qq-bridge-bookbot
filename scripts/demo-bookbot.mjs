// Offline demonstration: no config, account, DSH process, network or QQ sends.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BookbotStore } from '../src/bookbot-store.js';
import assert from 'node:assert/strict';
import { Bookbot } from '../src/bookbot.js';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-bookbot-demo-'));
const store=new BookbotStore(path.join(dir,'books.sqlite'));
const now=Date.parse('2026-10-10T03:00:00Z');
const cfg={ownerQQ:'100',allow:{groups:['600']},bookbot:{enabled:true,groups:['600'],onlyBooks:true}};
const extracted={
  '1': {title:'星海拾光',author:'青禾',kind:'recommend',tags:['科幻','慢热'],opinion:'人物写得好',wordCount:'120万字',status:'连载',evidence:'推荐青禾的《星海拾光》，科幻慢热，人物写得好，120万字，连载'},
  '2': {title:'星海拾光',author:'青禾',kind:'review',tags:['慢热'],opinion:'前期节奏慢',wordCount:null,status:null,evidence:'这本前期节奏慢，我喜欢它的人物'},
  '3': {title:'长风渡月',author:null,kind:'mention',tags:[],opinion:null,wordCount:null,status:null,evidence:'刚听说《长风渡月》，还没看'},
};
extracted['9']={...extracted['1'],kind:'mention',opinion:null,evidence:'推荐青禾的《星海拾光》，120万字，连载'};
extracted['10']={...extracted['1'],evidence:'我推荐青禾的星海拾光，人物写得好，130万字，连载',wordCount:'130万字'};
const bot=new Bookbot({store,getConfig:()=>cfg,now:()=>now,
  recognizeImages:async()=>({images:[{index:1,text:extracted['9'].evidence}]}),
  transcribeVoice:async source=>source.messageId==='voice-query'?'我今天推过哪些书？':extracted['10'].evidence,
  interpret:async source=>({action:source.messageId==='off-topic'?'unrelated':'query',period:source.messageId==='off-topic'?'all':'today',title:null,user:source.messageId==='off-topic'?null:'我',tags:source.messageId==='compound'?['科幻','慢热']:[],kind:source.messageId==='off-topic'?'all':'recommend'}),
  extract:async batch=>({entries:batch.filter(m=>extracted[m.messageId]).map(m=>({sourceId:m.messageId,...extracted[m.messageId]}))}),
  send:async (_key,reply)=>console.log(reply+'\n'),
});
const event=(messageId,user,text,quoteId)=>({self_id:'900',group_id:'600',user_id:user,message_id:messageId,time:now/1000,
  sender:{nickname:user==='201'?'小甲':'小乙'},message:[...(quoteId?[{type:'reply',data:{id:quoteId}}]:[]),{type:'text',data:{text}}]});
try {
  console.log('离线书单演示：临时 SQLite + 固定提取夹具，未连接 QQ/DSH。\n');
  await bot.handle(event('1','201',extracted['1'].evidence));
  await bot.handle(event('2','202',extracted['2'].evidence,'1'));
  await bot.handle(event('3','202',extracted['3'].evidence));
  await bot.handle(event('4','202','今天午饭吃面'));
  await bot.flush({force:true});
  await bot.handle({...event('9','203',''),message:[{type:'image',data:{file:'offline-screenshot.png'}}]});
  await bot.flush({force:true});
  assert.equal(store.query('900','600',{type:'title',value:'星海'}).recommenders,1);
  console.log('截图分享者不计推荐人；随后另一位群友用 QQ 语音推荐。\n');
  await bot.handle({...event('10','204',''),message:[{type:'record',data:{file:'offline-voice.amr'}}]});
  await bot.flush({force:true});
  assert.equal(store.query('900','600',{type:'title',value:'星海'}).recommenders,2);
  await bot.handle(event('5','202','/书单 今天'));
  await bot.handle(event('6','202','/书单 查 星海'));
  const mention={type:'at',data:{qq:'900'}};
  console.log('自然语言：原事件 @机器人，组合“我 + 今天 + 科幻 + 慢热”；普通无关聊天保持安静。\n');
  const compound=event('compound','201','帮我找找我今天推过的科幻慢热小说吧');compound.message.unshift(mention);await bot.handle(compound);
  const offTopic=event('off-topic','202','今天的天气如何');offTopic.message.unshift(mention);await bot.handle(offTopic);
  await bot.handle({...event('voice-query','204',''),message:[mention,{type:'record',data:{file:'offline-query.amr'}}]});
  await bot.flush({force:true});
  await bot.handle(event('7','201','/书单 撤销','1'));
  await bot.handle(event('8','202','/书单 今天'));
} finally {
  await bot.stop(); store.close(); fs.rmSync(dir,{recursive:true,force:true});
}
