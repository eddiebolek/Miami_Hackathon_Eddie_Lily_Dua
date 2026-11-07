import {route,auth,readBody,fail,send,checked,requireMember,UUID} from './_lib.js';
import {aiEnabled,chat,AiError,LIMITS,secondsToMidnightET} from '../lib/ai.js';

export default route(['POST'],async(req,res)=>{
  const {db}=await auth(req);
  const {team_id,messages,dataset_id}=await readBody(req);
  const bad=[];
  if(!UUID.test(team_id||''))bad.push('team_id must be a uuid.');
  if(dataset_id!=null&&!UUID.test(dataset_id))bad.push('dataset_id must be a uuid.');
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

  // All data comes from the signed-in user's own rows (RLS), never a service key. Every query also filters by this one team_id,
  // so even a platform developer who can see every company through RLS only gets this company. The model cannot change team_id.
  // Readable datasets: the true copy ('company data') and analyst uploads, newest first.
  const KIND={'company data':'true copy','analyst upload':'analyst upload'};
  const all=checked(await db.from('rhb_datasets').select('id,name,source,created_at').eq('team_id',team_id).order('created_at',{ascending:false}))
    .filter(d=>KIND[d.source]).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).map(d=>({id:d.id,name:d.name,kind:KIND[d.source],created_at:d.created_at}));
  if(dataset_id&&!all.some(d=>d.id===dataset_id))fail(404,'not_found','Dataset not found.');
  const load=async d=>({...d,rows:checked(await db.from('rhb_records').select('source_row,payload').eq('team_id',team_id).eq('dataset_id',d.id).order('source_row')).map(r=>({...r.payload,source_row:r.source_row}))});
  const copy=all.find(d=>d.kind==='true copy'),uploads=all.filter(d=>d.kind==='analyst upload');
  // Load the true copy, the chosen upload and the 4 newest uploads; the model picks among them with list_datasets.
  const want=[...new Set([dataset_id,copy?.id,...uploads.slice(0,4).map(d=>d.id)].filter(Boolean))];
  const datasets=await Promise.all(want.map(id=>load(all.find(d=>d.id===id))));
  const withRows=datasets.filter(d=>d.rows.length);
  // Default: the dataset being viewed, else the true copy if it has rows, else the latest upload.
  const def=dataset_id??(withRows.find(d=>d.kind==='true copy')??withRows.find(d=>d.kind==='analyst upload'))?.id??null;
  const found=checked(await db.from('rhb_findings').select('dataset_id,review_status,flag').eq('team_id',team_id).eq('method','deterministic').order('created_at').limit(500));
  const flags=found.map(r=>({...r.flag,dataset_id:r.dataset_id,review_status:r.review_status}));

  if(!checked(await db.rpc('rhb_ai_take',{kind:'chat',daily_max:LIMITS.chat}))){
    res.setHeader?.('Retry-After',String(secondsToMidnightET()));
    fail(429,'ai_limit','Daily AI question limit reached. Try again tomorrow.');
  }
  try{send(res,200,{data:await chat(recent,{datasets,default:def,flags})});}
  catch(e){
    if(!(e instanceof AiError))throw e;
    console.error('AI chat failed:',e.message);
    fail(502,'ai_failed','The AI could not answer this time. Try again in a moment.');
  }
});
