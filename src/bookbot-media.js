// Recognition is untrusted source material, never a command or identity source.
export const MAX_BOOK_IMAGES = 5;
export const MAX_RECOGNIZED_CHARS = 12000;
export function mediaOptions(cfg) {
  return {images:cfg.bookbot?.media?.images !== false,voice:cfg.bookbot?.media?.voice === undefined || cfg.bookbot.media.voice === 'qq'};
}
export function captureMedia(segments,cfg) {
  const enabled=mediaOptions(cfg);const images=[];let imageCount=0;let invalid=false;let voice=false;
  for (const s of segments) {
    if(s.type==='record' && enabled.voice) voice=true;
    if(s.type!=='image' || !enabled.images) continue;
    imageCount++;
    if(imageCount>MAX_BOOK_IMAGES) {invalid=true;continue;}
    const ref={kind:'image'};
    for(const key of ['file','url']) if(s.data?.[key]!=null) {
      const value=s.data[key];
      if(typeof value!=='string' || value.length>(key==='file'?512:2048) || /[\u0000-\u001f\u007f]/.test(value)) invalid=true;
      else if(value) ref[key]=value;
    }
    if(!ref.file && !ref.url) invalid=true;
    images.push(ref);
  }
  return {images,voice,...(invalid?{invalidImages:true}:{})};
}
export function validateImageRecognition(output,count) {
  let data;try{data=typeof output==='string'?JSON.parse(output):output;}catch{throw Error('Invalid image recognition');}
  if(!Number.isInteger(count)||count<1||count>MAX_BOOK_IMAGES||!data||Array.isArray(data)||Object.keys(data).join(',')!=='images'||!Array.isArray(data.images)||data.images.length!==count)throw Error('Invalid image recognition');
  let total=0;
  for(let i=0;i<count;i++) {
    const item=data.images[i];
    if(!item||Array.isArray(item)||Object.keys(item).length!==2||!Object.hasOwn(item,'index')||!Object.hasOwn(item,'text')||item.index!==i+1||typeof item.text!=='string'||item.text.length>MAX_RECOGNIZED_CHARS)throw Error('Invalid image recognition');
    total+=item.text.length;
  }
  if(total>MAX_RECOGNIZED_CHARS)throw Error('Image recognition too long');
  return data.images.map(item=>({index:item.index,text:item.text}));
}
export function validateVoiceText(value) {
  if(typeof value!=='string'||!value.trim()||value.length>MAX_RECOGNIZED_CHARS)throw Error('Invalid QQ voice transcription');
  return value;
}
export function channelTexts(m) {
  return [{origin:'text',text:m.text||''},{origin:'voice',text:m.recognition?.voice||''},...(m.recognition?.images||[]).map(i=>({origin:'image',text:i.text}))];
}
export function proofOrigin(m,value) {return channelTexts(m).find(c=>c.text.includes(value))?.origin;}
export function entryOrigins(m,e) {
  const evidenceOrigin=proofOrigin(m,e.evidence);
  if(evidenceOrigin==='image' && (e.kind!=='mention'||e.opinion!==null))throw Error('Image evidence cannot attribute recommendation/opinion to uploader');
  if(m.recognition?.images?.length && e.opinion!==null && !channelTexts(m).some(c=>c.origin!=='image' && c.text.includes(e.opinion)))throw Error('Image-bearing source opinion must quote caption or QQ voice');
  return {evidenceOrigin:evidenceOrigin||'text',wordCountOrigin:e.wordCount===null?null:proofOrigin(m,e.wordCount),statusOrigin:e.status===null?null:proofOrigin(m,e.status)};
}
export async function fetchQqVoiceText(source,cfg,{fetch:fetcher=globalThis.fetch,timeoutMs=30000,assertAuthorized=()=>{}}={}) {
  assertAuthorized();
  const httpUrl=String(cfg.snowluma?.httpUrl||'http://127.0.0.1:3000').replace(/\/+$/,'');
  const res=await fetcher(`${httpUrl}/fetch_ptt_text`,{method:'POST',headers:{'content-type':'application/json',...(cfg.snowluma?.accessToken?{authorization:`Bearer ${cfg.snowluma.accessToken}`}:{})},body:JSON.stringify({message_id:String(source.messageId)}),signal:AbortSignal.timeout(timeoutMs)});
  const body=await res.json();
  if(!res.ok||body?.status!=='ok'||body.retcode!==0)throw Error('QQ voice transcription unavailable');
  assertAuthorized();return validateVoiceText(body.data?.text);
}
