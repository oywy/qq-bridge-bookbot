import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureMedia, validateImageRecognition, validateVoiceText, channelTexts, entryOrigins } from './bookbot-media.js';
import {validateQueryPlan,periodRange} from './bookbot-query.js';
const decoded = m => ({...m,responseRequested:m.responseRequested===1,botQuote:m.botQuote?JSON.parse(m.botQuote):null,media:JSON.parse(m.media||'{}'),recognition:JSON.parse(m.recognition||'{}')});

const normalize = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
export function periodStart(period, now) {
  const local = new Date(now + 8 * 3600000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 8 * 3600000;
  if (period === 'week') return midnight - ((local.getUTCDay() + 6) % 7) * 86400000;
  if (period === 'seven') return midnight - 6 * 86400000;
  return midnight;
}

// Every source/queue row is retained as a dedup/cancellation tombstone. Only
// unreferenced, successfully processed raw text is cleared by retention.
export class BookbotStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.function('bookbot_normalize_tag',{deterministic:true},normalize);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, accountId TEXT NOT NULL, groupId TEXT NOT NULL,
        messageId TEXT NOT NULL, userId TEXT NOT NULL, name TEXT NOT NULL,
        text TEXT NOT NULL, time INTEGER NOT NULL, quoteId TEXT,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        retryAt INTEGER NOT NULL DEFAULT 0, UNIQUE(accountId,groupId,messageId));
      CREATE INDEX IF NOT EXISTS queue ON messages(state,retryAt,accountId,groupId,id);
      CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY, accountId TEXT NOT NULL, groupId TEXT NOT NULL,
        title TEXT NOT NULL, author TEXT, titleKey TEXT NOT NULL, authorKey TEXT NOT NULL,
        UNIQUE(accountId,groupId,titleKey,authorKey));
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY, source INTEGER NOT NULL REFERENCES messages(id),
        book INTEGER NOT NULL REFERENCES books(id), kind TEXT NOT NULL,
        tags TEXT NOT NULL, opinion TEXT, wordCount TEXT, status TEXT, evidence TEXT NOT NULL,
        UNIQUE(source,book,kind));
      CREATE INDEX IF NOT EXISTS entries_book ON entries(book,source);
      UPDATE messages SET state='pending' WHERE state='processing';`);
    // Additive migration supports databases populated by the text-only release.
    for (const [table,columns] of Object.entries({messages:{media:"TEXT NOT NULL DEFAULT '{}'",recognition:"TEXT NOT NULL DEFAULT '{}'",responseRequested:'INTEGER NOT NULL DEFAULT 0',botQuote:'TEXT'},entries:{evidenceOrigin:"TEXT NOT NULL DEFAULT 'text'",wordCountOrigin:"TEXT",statusOrigin:"TEXT"}})) {
      const present=new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
      for(const [column,type] of Object.entries(columns)) if(!present.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  close() { if (this.db) { this.db.close(); this.db = null; } }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  capture(m) {
    if (![m.accountId,m.groupId,m.messageId,m.userId].every(v => typeof v === 'string' && v)) throw new Error('Bookbot message identity missing');
    const segments=[...(m.media?.images||[]).map(image=>({type:'image',data:image})),...(m.media?.voice?[{type:'record'}]:[])];
    const media=captureMedia(segments,{bookbot:{}});
    if(m.media?.invalidImages)media.invalidImages=true;
    const botQuote=m.botQuote && typeof m.botQuote.messageId==='string' && typeof m.botQuote.text==='string'
      ? {messageId:m.botQuote.messageId.slice(0,100),text:m.botQuote.text.slice(0,200)} : null;
    return this.db.prepare('INSERT OR IGNORE INTO messages(accountId,groupId,messageId,userId,name,text,time,quoteId,media,responseRequested,botQuote) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(m.accountId,m.groupId,m.messageId,m.userId,String(m.name ?? ''),m.text,m.time,m.quoteId ?? null,JSON.stringify(media),m.responseRequested===true?1:0,botQuote?JSON.stringify(botQuote):null).changes === 1;
  }
  groups(now = Date.now()) {
    return this.db.prepare("SELECT accountId,groupId,COUNT(*) AS count,MIN(time) AS oldest FROM messages WHERE state='pending' AND retryAt<=? GROUP BY accountId,groupId ORDER BY MIN(id)").all(now);
  }
  claim(accountId, groupId, limit, now) {
    return this.transaction(() => {
      const batch = this.db.prepare("SELECT * FROM messages WHERE accountId=? AND groupId=? AND state='pending' AND retryAt<=? ORDER BY id LIMIT ?").all(accountId,groupId,now,limit);
      const claim = this.db.prepare("UPDATE messages SET state='processing',attempts=attempts+1 WHERE id=?");
      for (const m of batch) claim.run(m.id);
      return batch.map(decoded);
    });
  }
  isProcessing(source) { return this.db.prepare('SELECT state FROM messages WHERE id=?').get(source.id)?.state === 'processing'; }
  readSource(source) {
    const row=this.db.prepare('SELECT * FROM messages WHERE id=? AND accountId=? AND groupId=?').get(source.id,source.accountId,source.groupId);
    return row?decoded(row):null;
  }
  savedEntries(source) { return this.db.prepare('SELECT COUNT(*) AS n FROM entries e JOIN messages m ON m.id=e.source WHERE e.source=? AND m.state=\'done\'').get(source.id).n; }
  saveRecognition(source,patch) {
    return this.transaction(() => {
      const row=this.db.prepare('SELECT * FROM messages WHERE id=?').get(source.id);
      if(row?.state!=='processing') return false;
      const live=decoded(row);const next={...live.recognition};
      if(Object.hasOwn(patch,'images')) next.images=validateImageRecognition({images:patch.images},live.media.images?.length||0);
      if(Object.hasOwn(patch,'voice')) next.voice=validateVoiceText(patch.voice);
      this.db.prepare("UPDATE messages SET recognition=? WHERE id=? AND state='processing'").run(JSON.stringify(next),source.id);
      source.recognition=next;return true;
    });
  }
  retry(batch, retryAt) {
    const update = this.db.prepare("UPDATE messages SET state='pending',retryAt=? WHERE id=? AND state='processing'");
    this.transaction(() => { for (const m of batch) update.run(retryAt,m.id); });
  }
  context(batch, limit = 30, maxChars = 12000, media = {}) {
    if (!batch.length) return [];
    const first = batch[0]; const ids = new Set(batch.map(m => m.id));
    const byId = new Map();
    // Quote linkage is same account + group and cannot revive cancelled records.
    for (const m of batch) if (m.quoteId) {
      const quoted = this.db.prepare("SELECT * FROM messages WHERE accountId=? AND groupId=? AND messageId=? AND state!='cancelled' AND (text!='' OR recognition!='{}')").get(first.accountId,first.groupId,m.quoteId);
      if (quoted && !ids.has(quoted.id)) byId.set(quoted.id,decoded(quoted));
    }
    const recent = this.db.prepare("SELECT * FROM messages WHERE accountId=? AND groupId=? AND id<? AND state!='cancelled' AND (text!='' OR recognition!='{}') ORDER BY id DESC LIMIT ?").all(first.accountId,first.groupId,first.id,limit);
    for (const m of recent) if (!byId.has(m.id)) byId.set(m.id,decoded(m));
    const result = []; let chars = 0;
    for (const m of byId.values()) {
      // Retry caches from uncompleted sources follow today's channel switches.
      // Done sources remain historical proof; filter before spending the context budget.
      if(m.state==='pending' || m.state==='processing') m.recognition={
        ...(media.images!==false && m.recognition.images?{images:m.recognition.images}:{}),
        ...(media.voice!==false && m.recognition.voice?{voice:m.recognition.voice}:{}),
      };
      const size=channelTexts(m).reduce((n,c)=>n+c.text.length,0);
      if (result.length >= limit || chars + size > maxChars) continue;
      result.push(m); chars += size;
    }
    return result.sort((a,b) => a.id-b.id);
  }
  complete(batch, entries) {
    this.transaction(() => {
      const sources = new Map(batch.map(m => [m.messageId,m]));
      for (const e of entries) {
        const source = sources.get(e.sourceId);
        if (!source) throw new Error('Invalid bookbot source');
        const live = this.db.prepare('SELECT * FROM messages WHERE id=?').get(source.id);
        if (live?.state !== 'processing') continue; // withdrawal wins over in-flight results
        const proof=decoded(live);
        // Disabled cached channels are retained durably but cannot label new entries.
        if(source.recognition)proof.recognition=Object.fromEntries(Object.entries(proof.recognition).filter(([channel])=>Object.hasOwn(source.recognition,channel)));
        const origins=entryOrigins(proof,e);
        this.db.prepare('INSERT OR IGNORE INTO books(accountId,groupId,title,author,titleKey,authorKey) VALUES(?,?,?,?,?,?)')
          .run(source.accountId,source.groupId,e.title,e.author,normalize(e.title),normalize(e.author));
        const book = this.db.prepare('SELECT id FROM books WHERE accountId=? AND groupId=? AND titleKey=? AND authorKey=?').get(source.accountId,source.groupId,normalize(e.title),normalize(e.author));
        this.db.prepare('INSERT INTO entries(source,book,kind,tags,opinion,wordCount,status,evidence,evidenceOrigin,wordCountOrigin,statusOrigin) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(source.id,book.id,e.kind,JSON.stringify(e.tags),e.opinion,e.wordCount,e.status,e.evidence,origins.evidenceOrigin,origins.wordCountOrigin,origins.statusOrigin);
      }
      const finish = this.db.prepare("UPDATE messages SET state='done' WHERE id=? AND state='processing'");
      for (const m of batch) finish.run(m.id);
    });
  }
  cancel(accountId,groupId,messageId,userId,ownerId) {
    return this.transaction(() => {
      const m = this.db.prepare('SELECT * FROM messages WHERE accountId=? AND groupId=? AND messageId=?').get(accountId,groupId,messageId);
      if (!m) return { ok:false, reason:'未找到本群原消息记录' };
      if (m.userId !== userId && (!ownerId || userId !== ownerId)) return { ok:false, reason:'只能撤销自己的记录；管理员可撤销本群记录' };
      this.db.prepare("UPDATE messages SET state='cancelled',text='',media='{}',recognition='{}',botQuote=NULL WHERE id=?").run(m.id);
      this.db.prepare('DELETE FROM entries WHERE source=?').run(m.id);
      return { ok:true };
    });
  }
  prune(before) {
    return this.db.prepare("UPDATE messages SET text='',media='{}',recognition='{}',botQuote=NULL WHERE state='done' AND time<? AND (text!='' OR recognition!='{}' OR media!='{}' OR botQuote IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM entries WHERE source=messages.id)").run(before).changes;
  }
  catalogue(accountId,groupId) {
    const users=this.db.prepare("SELECT DISTINCT m.userId,substr(m.name,1,100) AS name FROM messages m JOIN entries e ON e.source=m.id WHERE m.accountId=? AND m.groupId=? AND m.state='done' ORDER BY m.userId,m.name LIMIT 100").all(accountId,groupId);
    const tags=this.db.prepare("SELECT DISTINCT substr(j.value,1,30) AS tag FROM entries e JOIN messages m ON m.id=e.source,json_each(e.tags) j WHERE m.accountId=? AND m.groupId=? AND m.state='done' ORDER BY tag LIMIT 100").all(accountId,groupId).map(r=>r.tag);
    return {users,tags};
  }
  queryNatural(accountId,groupId,output,requesterId,now=Date.now()) {
    const plan=validateQueryPlan(output);if(plan.action!=='query')throw Error('Expected query plan');
    let userId=plan.user;
    if(userId==='我' || userId==='自己')userId=requesterId;
    else if(userId!==null && !/^\d+$/.test(userId)) {
      const names=this.db.prepare("SELECT DISTINCT m.userId,m.name FROM messages m JOIN entries e ON e.source=m.id WHERE m.accountId=? AND m.groupId=? AND m.state='done'").all(accountId,groupId);
      const ids=[...new Set(names.filter(m=>normalize(m.name)===normalize(userId)).map(m=>m.userId))];
      if(ids.length>1)return {clarify:'user'};
      if(!ids.length)return {command:{type:'natural',plan},totalBooks:0,recommenders:0,books:[]};
      userId=ids[0];
    }
    return this.query(accountId,groupId,{type:'natural',plan,userId},now);
  }
  query(accountId,groupId,command,now = Date.now(),limit = 8) {
    const conditions = ['b.accountId=?','b.groupId=?']; const args = [accountId,groupId];
    const event = ["m.state='done'"]; const eventArgs = [];
    if (command.type === 'period') { event.push("e.kind='recommend'",'m.time>=?','m.time<=?'); eventArgs.push(periodStart(command.value,now),now); }
    if (command.type === 'user') { event.push("e.kind='recommend'",'m.userId=?'); eventArgs.push(command.value); }
    if (command.type === 'title') { conditions.push('instr(b.titleKey,?)>0'); args.push(normalize(command.value)); }
    if (command.type === 'tags') for (const tag of command.value.split(/[，,\s]+/).filter(Boolean)) { event.push('instr(lower(e.tags),?)>0'); eventArgs.push(JSON.stringify(normalize(tag))); }
    if(command.type==='natural') {
      const p=command.plan;
      if(p.title!==null){conditions.push('instr(b.titleKey,?)>0');args.push(normalize(p.title));}
      if(command.userId!==null){event.push('m.userId=?');eventArgs.push(command.userId);}
      if(p.kind!=='all'){event.push('e.kind=?');eventArgs.push(p.kind);}
      const range=periodRange(p.period,now);if(range){event.push('m.time>=?','m.time<?');eventArgs.push(...range);}
      for(const tag of p.tags){event.push('EXISTS(SELECT 1 FROM json_each(e.tags) j WHERE bookbot_normalize_tag(j.value)=?)');eventArgs.push(normalize(tag));}
    }
    const matching = `SELECT DISTINCT b.id FROM books b JOIN entries e ON e.book=b.id JOIN messages m ON m.id=e.source WHERE ${conditions.join(' AND ')} AND ${event.join(' AND ')}`;
    const params = [...args,...eventArgs];
    const totalBooks = this.db.prepare(`SELECT COUNT(*) AS n FROM (${matching})`).get(...params).n;
    // Counts apply the event filter, never the bounded rendered rows.
    const recommenders = this.db.prepare(`SELECT COUNT(DISTINCT m.userId) AS n FROM books b JOIN entries e ON e.book=b.id JOIN messages m ON m.id=e.source WHERE ${conditions.join(' AND ')} AND ${event.join(' AND ')} AND e.kind='recommend'`).get(...params).n;
    const books = this.db.prepare(`SELECT b.* FROM books b WHERE b.id IN (${matching}) ORDER BY (SELECT MAX(m.time) FROM entries e JOIN messages m ON m.id=e.source WHERE e.book=b.id) DESC,b.id LIMIT ?`).all(...params,limit);
    for (const b of books) {
      b.matchingRecommenders = this.db.prepare(`SELECT m.userId,m.name,MIN(m.time) AS time,m.messageId,e.evidenceOrigin FROM books b JOIN entries e ON e.book=b.id JOIN messages m ON m.id=e.source WHERE b.id=? AND ${event.join(' AND ')} AND e.kind='recommend' GROUP BY m.userId ORDER BY time LIMIT 6`).all(b.id,...eventArgs);
      b.first = this.db.prepare("SELECT m.userId,m.name,m.time,m.messageId,e.evidenceOrigin FROM entries e JOIN messages m ON m.id=e.source WHERE e.book=? AND e.kind='recommend' AND m.state='done' ORDER BY m.time,m.id LIMIT 1").get(b.id) ?? null;
      for (const field of ['wordCount','status']) {
        b[field+'Report'] = this.db.prepare(`SELECT e.${field} AS value,COALESCE(e.${field}Origin,'text') AS origin,m.userId,m.name,m.time,m.messageId FROM entries e JOIN messages m ON m.id=e.source WHERE e.book=? AND m.state='done' AND e.${field} IS NOT NULL ORDER BY m.time DESC,e.id DESC LIMIT 1`).get(b.id) ?? null;
      }
      b.entries = command.type==='natural'
        ? this.db.prepare(`SELECT e.*,m.userId,m.name,m.time,m.messageId FROM entries e JOIN messages m ON m.id=e.source WHERE e.book=? AND ${event.join(' AND ')} ORDER BY m.time DESC,e.id DESC LIMIT 4`).all(b.id,...eventArgs).map(e=>({...e,tags:JSON.parse(e.tags)}))
        : this.db.prepare("SELECT e.*,m.userId,m.name,m.time,m.messageId FROM entries e JOIN messages m ON m.id=e.source WHERE e.book=? AND m.state='done' ORDER BY m.time DESC,e.id DESC LIMIT 4").all(b.id).map(e => ({...e,tags:JSON.parse(e.tags)}));
    }
    return { command, totalBooks, recommenders, books };
  }
}
