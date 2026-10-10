import { validateExtraction } from './bookbot-extractor.js';
import { captureMedia, mediaOptions, validateImageRecognition, validateVoiceText } from './bookbot-media.js';
import {validateQueryPlan,BOOK_UNRELATED,BOOK_CLARIFY,BOOK_SERVICE_ERROR,BOOK_USER_CLARIFY} from './bookbot-query.js';

const list = value => Array.isArray(value) ? value.map(String) : [];
export function bookbotAllowed(groupId,cfg) {
  const group = String(groupId);
  return cfg.bookbot?.enabled === true && list(cfg.bookbot.groups).includes(group)
    && list(cfg.allow?.group ?? cfg.allow?.groups).includes(group)
    && !list(cfg.deny?.group ?? cfg.deny?.groups).includes(group);
}
export function bookbotOnlyBooks(groupId,cfg) { return bookbotAllowed(groupId,cfg) && cfg.bookbot.onlyBooks === true; }
export function parseBookCommand(text,{mentioned = false} = {}) {
  const s = text.trim(); let tail;
  if (/^\/书单(?:\s|$)/.test(s)) tail = s.slice(3).trim();
  else if (mentioned) {
    if (/^(今天|本周|近七天)(推书|书单)[？?]?$/.test(s)) tail = s.replace(/推书|书单|[？?]/g,'');
    else if (/^查书\s+/.test(s)) tail = '查 '+s.slice(3).trim();
    else return null;
  } else return null;
  if (tail === '今天') return {type:'period',value:'today'};
  if (tail === '本周') return {type:'period',value:'week'};
  if (tail === '近七天') return {type:'period',value:'seven'};
  if (tail === '撤销') return {type:'cancel'};
  const match = /^(查|推荐人|找)\s+(.+)$/.exec(tail);
  if (match && (match[1] !== '推荐人' || /^\d+$/.test(match[2]))) return {type:{查:'title',推荐人:'user',找:'tags'}[match[1]],value:match[2]};
  return {type:'help'};
}
export const BOOK_HELP = '书单：/书单 今天｜本周｜近七天；/书单 查 书名；/书单 推荐人 QQ号；/书单 找 标签。引用自己的原消息后发 /书单 撤销。只记录本群在线消息；字数/状态为群友报告，提取可能稍有延迟。';
export const bookTime = time => new Date(time).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
export function renderBookQuery(result,maxChars = 3500) {
  const heading = result.command.type === 'period' ? {today:'今天',week:'本周（周一起）',seven:'近七天（含今天）'}[result.command.value]+'推书' : '本群书单查询';
  let text = `${heading}：${result.totalBooks} 本，${result.recommenders} 位推荐人。`;
  if (!result.books.length) return text+'暂无记录。';
  const footer = result.command.type==='natural'?'\n每本最多展示最近4条匹配记录；首次推荐及字数/状态另列有效历史来源；未联网核实。':'\n每本最多展示最近4条记录；未联网核实字数/状态。';
  const omission = '\n部分记录或内容已省略。';
  const more = shown => `\n仅展示 ${shown}/${result.totalBooks} 本；用“/书单 查 书名”缩小查询。`;
  const limit = maxChars-footer.length-omission.length-more(0).length;
  let shown = 0; let omitted = false;
  const add = (line,compact) => {
    if (text.length+line.length <= limit) { text += line; return; }
    omitted = true;
    if (compact && text.length+compact.length <= limit) text += compact;
  };
  const originLabel=origin=>origin==='image'?'图片识别':origin==='voice'?'QQ语音转写':'';
  const source = (m,compact = false) => `${compact ? m.userId : `${m.name || m.userId}（${m.userId}）`}，${bookTime(m.time)} [消息 ${m.messageId}]${originLabel(m.evidenceOrigin)?'（'+originLabel(m.evidenceOrigin)+'）':''}`;
  for (const b of result.books) {
    const title = `\n《${b.title}》`;
    if (text.length+title.length > limit) break;
    text += title; shown++;
    const matching = m => add('\n本次查询推荐人：'+source(m),'\n本次查询推荐人：'+source(m,true));
    if (b.matchingRecommenders.length) matching(b.matchingRecommenders[0]);
    for (const [field,label] of [['wordCount','字数'],['status','状态']]) {
      const report=b[field+'Report'];
      if (report) {const reportLabel=report.origin==='image'?'图片识别':report.origin==='voice'?'QQ语音转写报告':'群友报告';add(`\n${reportLabel}${label}：${report.value}；${report.origin==='image'?'分享者 ':''}${source(report)}`,`\n${reportLabel}${label}：${report.value}；${report.origin==='image'?'分享者 ':''}${source(report,true)}`);}
    }
    add(b.author ? '\n作者：'+b.author : '\n作者未记录');
    if (b.first) add('\n本群首次记录：'+source(b.first),'\n本群首次记录：'+source(b.first,true));
    for (const m of b.matchingRecommenders.slice(1)) matching(m);
    for (const e of b.entries) {
      const provenance=e.evidenceOrigin==='image'?'图片识别 / 分享者 ':e.evidenceOrigin==='voice'?'QQ语音转写 ':'';
      let block = `\n${result.command.type==='natural'?'本次查询匹配记录：':''}${provenance}${{mention:'提及',recommend:'推荐',review:'评价'}[e.kind]} ${e.name || e.userId}（${e.userId}）：${e.opinion || e.evidence}`;
      if (e.tags.length) block += '；标签 '+e.tags.join('、');
      if((!e.wordCount || !e.wordCountOrigin || e.wordCountOrigin==='text') && (!e.status || !e.statusOrigin || e.statusOrigin==='text')) {
        if(e.wordCount || e.status)block+=`；群友报告 ${[e.wordCount,e.status].filter(Boolean).join(' / ')}（${bookTime(e.time)}）`;
      } else for(const [field,label] of [['wordCount','字数'],['status','状态']])if(e[field]) {
        const origin=e[field+'Origin'];block+=`；${origin==='image'?'图片识别':origin==='voice'?'QQ语音转写报告':'群友报告'}${label} ${e[field]}`;
      }
      block += ` [消息 ${e.messageId}，${bookTime(e.time)}]`;
      add(block);
    }
  }
  if (omitted) text += omission;
  if (shown < result.totalBooks) text += more(shown);
  return text+footer;
}

const positive = (value,fallback,max) => Number.isFinite(Number(value)) && Number(value)>0 ? Math.min(max,Math.floor(Number(value))) : fallback;
export class Bookbot {
  constructor({store,getConfig,extract,interpret,resolveBotQuote,recognizeImages,transcribeVoice,send,now = Date.now,log = () => {}}) { Object.assign(this,{store,getConfig,extract,interpret,resolveBotQuote,recognizeImages,transcribeVoice,send,now,log}); this.running = false; this.stopped = false; }
  start() { this.timer = setInterval(() => { this.flush().catch(() => this.log('书单后台处理失败')); },1000); this.timer.unref?.(); }
  async stop() { this.stopped=true; clearInterval(this.timer); if (this.done) await this.done; }
  async handle(event) {
    const cfg = this.getConfig(); const groupId = String(event.group_id ?? ''); const accountId = String(event.self_id ?? ''); const userId = String(event.user_id ?? event.sender?.user_id ?? '');
    if (this.stopped || !accountId || !userId || userId === accountId || !bookbotAllowed(groupId,cfg)) return false;
    const segments = Array.isArray(event.message) ? event.message : [];
    const text = typeof event.message === 'string' ? event.message : segments
      .filter(s => s.type === 'text' || s.type === 'markdown')
      .map(s => String(s.data?.text ?? (s.type === 'markdown' ? s.data?.content : '') ?? '')).join('');
    const quoteId = segments.find(s => s.type === 'reply')?.data?.id;
    const mentioned = segments.some(s => s.type === 'at' && String(s.data?.qq) === accountId);
    const command = parseBookCommand(text,{mentioned});
    if (command) {
      let reply;
      if (command.type === 'help') reply = BOOK_HELP;
      else if (command.type === 'cancel') {
        if (quoteId == null) reply = '请引用原消息后发送 /书单 撤销。';
        else { const result=this.store.cancel(accountId,groupId,String(quoteId),userId,String(cfg.ownerQQ ?? '')); reply=result.ok ? '已撤销该消息的书单记录。' : result.reason; }
      } else reply = renderBookQuery(this.store.query(accountId,groupId,command,this.now()),Math.max(500,positive(cfg.bookbot.maxReplyChars,3500,5000)));
      if (bookbotAllowed(groupId,this.getConfig())) await this.send(`group:${groupId}`,reply);
      return true;
    }
    let botQuote=null;
    if(cfg.bookbot.naturalLanguage!==false && quoteId!=null && this.resolveBotQuote) {
      try {
        const info=await this.resolveBotQuote({accountId,groupId,messageId:String(quoteId)});
        if(info?.userId===accountId && (info.accountId==null || String(info.accountId)===accountId) && (info.groupId==null || String(info.groupId)===groupId) && typeof info.text==='string')botQuote={messageId:String(quoteId),text:info.text.slice(0,200)};
      } catch {} // An unavailable gateway does not verify a bot quote.
    }
    const current=this.getConfig();
    if(this.stopped || !bookbotAllowed(groupId,current))return false;
    const responseRequested=current.bookbot.naturalLanguage!==false && (mentioned || botQuote!==null);
    if(current.bookbot.naturalLanguage===false)botQuote=null;
    const messageId = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const media=captureMedia(segments,current);
    if ((text.trim() || media.images.length || media.voice || media.invalidImages || responseRequested) && messageId) this.store.capture({accountId,groupId,messageId,userId,name:String(event.sender?.card || event.sender?.nickname || ''),text,media,time:Number.isFinite(Number(event.time)) ? Number(event.time)*1000 : this.now(),quoteId:quoteId==null ? null : String(quoteId),responseRequested,botQuote});
    if (!this.running && this.store.groups(this.now()).some(g => g.count >= positive(cfg.bookbot.maxBatch,30,100))) void this.flush();
    return responseRequested || current.bookbot.onlyBooks === true;
  }
  // One fresh gate is shared by planning, extraction and their awaited returns.
  freshBatch(batch,options) {
    const cfg=this.getConfig();
    if(this.stopped || !batch.length || !bookbotAllowed(batch[0].groupId,cfg)){this.store.retry(batch,this.now());return [];}
    const active=mediaOptions(cfg);const ready=[];
    for(const original of batch) {
      const source=this.store.readSource(original);if(source?.state!=='processing')continue;
      if((active.images && (source.media.images?.length || source.media.invalidImages) && (source.media.invalidImages || !source.recognition.images)) || (active.voice && source.media.voice && !source.recognition.voice)) {
        this.store.retry([source],this.now()+positive(options.retryMs,60000,3600000));continue;
      }
      source.recognition={...(active.images && source.recognition.images?{images:source.recognition.images}:{}),...(active.voice && source.recognition.voice?{voice:source.recognition.voice}:{})};
      ready.push(source);
    }
    return ready;
  }
  context(batch,options) { return this.store.context(batch,positive(options.contextMessages,30,100),positive(options.contextChars,12000,50000),mediaOptions(this.getConfig())); }
  stamp(source,context=[]) {
    const view=m=>({id:m.id,text:m.text,recognition:m.recognition,botQuote:m.botQuote});
    return JSON.stringify({source:view(source),context:context.map(view),natural:this.getConfig().bookbot?.naturalLanguage!==false});
  }
  replyGuard(source,state,stamp) {
    return ()=>{
      const cfg=this.getConfig();const live=this.store.readSource(source);
      if(this.stopped || !bookbotAllowed(source.groupId,cfg) || cfg.bookbot.naturalLanguage===false || live?.state!==state || !live.responseRequested)throw Error('Bookbot response no longer authorized');
      const active=mediaOptions(cfg);
      live.recognition={...(active.images && live.recognition.images?{images:live.recognition.images}:{}),...(active.voice && live.recognition.voice?{voice:live.recognition.voice}:{})};
      if(this.stamp(live)!==stamp)throw Error('Bookbot response input changed');
    };
  }
  async reply(source,{plan,stamp:plannedStamp},options) {
    let reply;let assertResult=()=>{};
    if(plan.action==='unrelated')reply=BOOK_UNRELATED;
    else if(plan.action==='clarify')reply=BOOK_CLARIFY;
    else if(plan.action==='record')reply=this.store.savedEntries(source)>0?'已记录这条消息的书籍讨论。':'这条消息没有识别到可保存的书籍条目，请补充明确书名和自己的推荐或评价。';
    else {
      const queryTime=this.now();
      const result=this.store.queryNatural(source.accountId,source.groupId,plan,source.userId,queryTime);
      const resultStamp=JSON.stringify(result);
      assertResult=()=>{if(JSON.stringify(this.store.queryNatural(source.accountId,source.groupId,plan,source.userId,queryTime))!==resultStamp)throw Error('Bookbot query evidence changed');};
      reply=result.clarify==='user'?BOOK_USER_CLARIFY:renderBookQuery(result,Math.max(500,positive(this.getConfig().bookbot.maxReplyChars,3500,5000)));
    }
    const sourceGuard=this.replyGuard(source,'done',this.stamp(source));
    const guard=()=>{
      sourceGuard();
      if(this.stamp(source,this.context([source],options))!==plannedStamp)throw Error('Bookbot planned context changed');
      assertResult();
    };
    guard();await this.send(`group:${source.groupId}`,reply,guard);
  }
  async flush({force = false} = {}) {
    if (this.running || this.stopped) return;
    this.running = true;
    let finish; this.done = new Promise(resolve => {finish=resolve;});
    try {
      const cfg = this.getConfig(); const options = cfg.bookbot ?? {};
      const maxBatch = positive(options.maxBatch,30,100);
      for (const group of this.store.groups(this.now())) {
        if (this.stopped) break;
        if (!bookbotAllowed(group.groupId,this.getConfig())) continue;
        if (!force && group.count < maxBatch && this.now()-group.oldest < positive(options.batchMs,15000,600000)) continue;
        const claimed = this.store.claim(group.accountId,group.groupId,maxBatch,this.now()); if (!claimed.length) continue;
        const batch=[];
        for(const source of claimed) {
          const assertAuthorized=()=>{if(this.stopped || !bookbotAllowed(source.groupId,this.getConfig()) || !this.store.isProcessing(source))throw Error('Bookbot source no longer authorized');};
          try {
            const assertChannel=channel=>()=>{
              assertAuthorized();
              if(!mediaOptions(this.getConfig())[channel])throw Error('Bookbot media channel disabled');
            };
            if(mediaOptions(this.getConfig()).images && (source.media.images?.length || source.media.invalidImages)) {
              try {
                const assertImages=assertChannel('images');assertImages();
                if(source.media.invalidImages)throw Error('Bookbot images exceed bounds');
                if(!source.recognition.images) {
                  const result=await this.recognizeImages(source,assertImages);
                  assertAuthorized();
                  if(!this.store.saveRecognition(source,{images:validateImageRecognition(result,source.media.images.length)}))throw Error('Source withdrawn');
                }
              } catch(error) {
                if(mediaOptions(this.getConfig()).images)throw error;
                assertAuthorized(); // a disabled channel no longer blocks its original caption
              }
            }
            // The image await may have changed settings; authorize every new channel handoff.
            if(mediaOptions(this.getConfig()).voice && source.media.voice && !source.recognition.voice) {
              try {
                const assertVoice=assertChannel('voice');assertVoice();
                const result=await this.transcribeVoice(source,assertVoice);assertAuthorized();
                if(!this.store.saveRecognition(source,{voice:validateVoiceText(result)}))throw Error('Source withdrawn');
              } catch(error) {
                if(mediaOptions(this.getConfig()).voice)throw error;
                assertAuthorized();
              }
            }
            assertAuthorized();
            batch.push(source);
          } catch {this.store.retry([source],this.now()+positive(options.retryMs,60000,3600000));this.log('书单媒体识别失败；原消息保留等待重试');}
        }
        let ready=this.freshBatch(batch,options);if(!ready.length)continue;
        const plans=new Map();
        for(const original of ready) {
          // Later awaits can withdraw earlier evidence or change its usable channels.
          const source=this.freshBatch([original],options)[0];if(!source)continue;
          if(!source.responseRequested || this.getConfig().bookbot.naturalLanguage===false)continue;
          const context=this.context([source],options);const stamp=this.stamp(source,context);
          try {
            const assertPlan=()=>{
              const live=this.freshBatch([source],options)[0];
              if(!live || this.stamp(live,this.context([live],options))!==stamp)throw Error('Bookbot planning input changed');
            };
            // OCR is reference material; it never becomes the request utterance.
            const output=source.text.trim() || source.recognition.voice?.trim()
              ? await this.interpret(source,context,this.store.catalogue(source.accountId,source.groupId),assertPlan)
              : {action:'clarify',period:'all',title:null,user:null,tags:[],kind:'all'};
            const live=this.freshBatch([source],options)[0];if(!live)continue;
            if(this.stamp(live,this.context([live],options))!==stamp){this.store.retry([live],this.now()+positive(options.retryMs,60000,3600000));continue;}
            plans.set(source.id,{plan:validateQueryPlan(output),stamp});
          } catch {
            const live=this.freshBatch([source],options)[0];
            if(live && this.stamp(live,this.context([live],options))===stamp) {
              try {const guard=this.replyGuard(live,'processing',this.stamp(live));guard();await this.send(`group:${live.groupId}`,BOOK_SERVICE_ERROR,guard);}catch{}
            }
            this.store.retry([source],this.now()+positive(options.retryMs,60000,3600000));
            this.log('书单规划失败；原消息保留等待重试');
          }
        }
        ready=this.freshBatch(ready,options).filter(source=>{
          const planned=plans.get(source.id);
          if(planned && this.stamp(source,this.context([source],options))!==planned.stamp) {
            this.store.retry([source],this.now()+positive(options.retryMs,60000,3600000));return false;
          }
          return true;
        });
        if(!ready.length)continue;
        try {
          const context=this.context(ready,options);
          const input=JSON.stringify(ready.map(source=>this.stamp(source,context)));
          const assertExtract=()=>{
            const live=this.freshBatch(ready,options);
            if(JSON.stringify(live.map(source=>this.stamp(source,this.context(live,options))))!==input)throw Error('Bookbot extraction input changed');
          };
          const output=await this.extract(ready,context,assertExtract);
          const live=this.freshBatch(ready,options);if(!live.length)continue;
          const freshContext=this.context(live,options);
          // A returned extraction may have consumed withdrawn or disabled proof.
          // Retrying is safer than committing a partially validated stale result.
          if(JSON.stringify(live.map(source=>this.stamp(source,freshContext)))!==input) {
            this.store.retry(live,this.now()+positive(options.retryMs,60000,3600000));continue;
          }
          const entries=validateExtraction(output,live,freshContext);
          this.store.complete(live,entries);
          for(const source of live)if(plans.has(source.id)) {
            try {await this.reply(source,plans.get(source.id),options);}catch{this.log('书单回复未发送');}
          }
        } catch {
          this.store.retry(ready,this.now()+positive(options.retryMs,60000,3600000));
          this.log('书单提取失败；批次保留等待重试'); // never log raw model/QQ content
        }
      }
      this.store.prune(this.now()-positive(options.rawRetentionDays,7,365)*86400000);
    } finally { this.running=false; finish(); this.done=null; }
  }
}
