import {route,auth,readBody,fail,send,checked,requireMember,trueCopy,UUID} from './_lib.js';
import {aiEnabled,chat,AiError,LIMITS,secondsToMidnightET} from '../lib/ai.js';

export default route(['POST'],async(req,res)=>{
  const {db}=await auth(req);
  const {team_id,messages}=await readBody(req);
  const bad=[];
  if(!UUID.test(team_id||''))bad.push('team_id must be a uuid.');
  if(!Array.isArray(messages)||!messages.length)bad.push('messages must be a non-empty list.');
  else{
    for(const m of messages)if(!m||!['user','assistant'].includes(m.role)||typeof m.content!=='string'||!m.content.trim()||m.content.length>(m.role==='user'?500:4000))bad.push(m?.role==='user'?'Questions must be 1 to 500 characters.':'Each message needs a role (user or assistant) and text.');
    if(messages.at(-1)?.role!=='user')bad.push('The last message must be from the user.');
  }
  if(bad.length)fail(422,'invalid_request',[...new Set(bad)].join(' '));
  if(!aiEnabled())fail(503,'ai_off','AI is not set up for this deployment. Everything else still works.');
  await requireMember(db,team_id);
  let recent=messages.slice(-6);
  while(recent[0].role!=='user')recent=recent.slice(1);

  // All data comes from the signed-in user's own rows (RLS), never a service key.
  const {records}=await trueCopy(db,team_id);
  const rows=records.map(r=>({...r.payload,source_row:r.source_row}));
  const found=checked(await db.from('rhb_findings').select('review_status,flag').eq('team_id',team_id).eq('method','deterministic').order('created_at').limit(500));
  const flags=found.map(r=>({...r.flag,review_status:r.review_status}));

  if(!checked(await db.rpc('rhb_ai_take',{kind:'chat',daily_max:LIMITS.chat}))){
    res.setHeader?.('Retry-After',String(secondsToMidnightET()));
    fail(429,'ai_limit','Daily AI question limit reached. Try again tomorrow.');
  }
  try{send(res,200,{data:await chat(recent,{rows,flags})});}
  catch(e){
    if(!(e instanceof AiError))throw e;
    console.error('AI chat failed:',e.message);
    fail(502,'ai_failed','The AI could not answer this time. Try again in a moment.');
  }
});
