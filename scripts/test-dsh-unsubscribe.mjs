import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NodeApiClient} from '../src/dsh-client.js';

// Verified cancellation wire: exactly {type:'cancel',streamId}, not uplink end.
// https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/api/gateway/src/stream-protocol.ts#L219-L251
test('forget cancels active mux subscriptions, drops queued/late frames, and preserves other events/reconnect', async () => {
  const sockets=[];
  class FakeWebSocket {
    static CONNECTING=0;static OPEN=1;static CLOSED=3;
    constructor(){this.readyState=0;this.listeners=new Map();this.frames=[];this.live=new Map();sockets.push(this);}
    addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
    removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
    emit(type,event={}){for(const fn of this.listeners.get(type)??[])fn(event);}
    send(text){const frame=JSON.parse(text);this.frames.push(frame);if(frame.type==='open')this.live.set(frame.streamId,frame);if(frame.type==='cancel')this.live.delete(frame.streamId);}
    open(){this.readyState=1;this.emit('open');}
    item(streamId,value){this.emit('message',{data:JSON.stringify({type:'item',streamId,value})});}
    close(){this.readyState=3;this.emit('close');}
  }
  const original=globalThis.WebSocket;globalThis.WebSocket=FakeWebSocket;
  const api=new NodeApiClient('http://127.0.0.1:1');
  api.ensureAuth=async()=>{api.cookie='fixture';};api.invalidateAuth=()=>{};
  const controllers=[];const iterators=[];
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  const followEvent=(turn)=>({type:'event',event:{type:'turn/start',data:{turn}}});
  try {
    const controller=new AbortController();controllers.push(controller);
    const it=api.events.mux({},controller.signal)[Symbol.asyncIterator]();iterators.push(it);
    const first=it.next();await tick();const socket=sockets[0];socket.open();
    api.events.follow('other');for(let i=0;i<4;i++)api.events.follow('book-'+i);
    const other=socket.frames.find(f=>f.endpoint==='session/follow'&&f.payload.args.request.address.sessionId==='other');
    const books=socket.frames.filter(f=>f.endpoint==='session/follow'&&f.payload.args.request.address.sessionId.startsWith('book-'));
    const events=socket.frames.find(f=>f.endpoint==='$events');
    socket.item(books[0].streamId,followEvent(1));
    socket.item(books[0].streamId,{type:'snapshot',records:[]}); // queued behind first yield
    socket.item(events.streamId,{type:'ready',clientId:'events-client'});
    socket.item(events.streamId,{type:'waterfall',event:'approval/request',eventId:'queued-book-approval',agentId:'book-0',request:{toolName:'fixture'}});
    assert.equal((await first).value.payload.sessionId,'book-0');
    api.events.forget('book-0');for(let i=1;i<4;i++)api.events.forget('book-'+i);
    const cancels=socket.frames.filter(f=>f.type==='cancel');
    assert.deepEqual(cancels,books.map(f=>({type:'cancel',streamId:f.streamId})));
    assert.equal(socket.live.size,2);assert.equal(api._desiredFollows.size,1);
    for(const book of books) {
      socket.item(book.streamId,followEvent(99));
      socket.item(book.streamId,{type:'snapshot',records:[{type:'event',event:followEvent(99).event}]});
      socket.emit('message',{data:JSON.stringify({type:'end',streamId:book.streamId})});
    }
    socket.item(other.streamId,followEvent(2));
    const queuedApproval=(await it.next()).value.payload;
    assert.equal(queuedApproval.type,'approval/requested');assert.equal(queuedApproval.eventId,'queued-book-approval','forget must preserve queued global events');
    assert.equal((await it.next()).value.payload.sessionId,'other','queued retired snapshot must be dropped');
    socket.item(events.streamId,{type:'ready',clientId:'events-client'});
    socket.item(events.streamId,{type:'waterfall',event:'approval/request',eventId:'unfollowed-approval',agentId:'unfollowed',request:{toolName:'fixture'}});
    socket.item(events.streamId,{type:'waterfall',event:'approval/request',eventId:'approval-1',agentId:'other',request:{toolName:'fixture'}});
    const approval=(await it.next()).value.payload;
    assert.equal(approval.type,'approval/requested');assert.equal(approval.sessionId,'unfollowed','$events is independent of session follows');
    assert.equal((await it.next()).value.payload.sessionId,'other');
    await new Promise(resolve=>setTimeout(resolve,2050));
    assert.equal(socket.frames.filter(f=>f.endpoint==='session/follow').length,5,'retired end must not refollow');
    socket.close();assert.equal((await it.next()).done,true);
    assert.equal(api._muxSendForget,null);
    const reconnectController=new AbortController();controllers.push(reconnectController);
    const reconnect=api.events.mux({},reconnectController.signal)[Symbol.asyncIterator]();iterators.push(reconnect);
    const next=reconnect.next();await tick();const second=sockets[1];second.open();
    assert.deepEqual(second.frames.filter(f=>f.endpoint==='session/follow').map(f=>f.payload.args.request.address.sessionId),['other']);
    assert.equal(second.frames.some(f=>f.endpoint==='$events'),true);
    const secondOther=second.frames.find(f=>f.endpoint==='session/follow');second.item(secondOther.streamId,followEvent(3));
    assert.equal((await next).value.payload.sessionId,'other');
  } finally {
    for(const controller of controllers)controller.abort();
    for(const it of iterators)await it.return();
    globalThis.WebSocket=original;
  }
});
