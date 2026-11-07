import {route,auth,readBody,fail,send,checked,UUID} from './_lib.js';
import {aiEnabled,buildReportInput,writeReport,AiError,LIMITS,secondsToMidnightET} from '../lib/ai.js';
import {summarize} from '../lib/summary.js';

export default route(['POST'],async(req,res)=>{
  const {db}=await auth(req);
  const {dataset_id}=await readBody(req);
  if(!UUID.test(dataset_id||''))fail(422,'invalid_request','dataset_id must be a uuid.');
  if(!aiEnabled())fail(503,'ai_off','AI is not set up for this deployment. Everything else still works.');
  // RLS: a dataset in another company simply is not visible here.
  const dataset=checked(await db.from('rhb_datasets').select('id,team_id,name').eq('id',dataset_id).maybeSingle());
  if(!dataset)fail(404,'not_found','Check not found.');
  const team=checked(await db.from('rhb_teams').select('name').eq('id',dataset.team_id).maybeSingle());
  const found=checked(await db.from('rhb_findings').select('review_status,flag').eq('dataset_id',dataset_id).eq('method','deterministic').order('created_at'));
  const flags=found.map(r=>({...r.flag,review_status:r.review_status}));
  const sheet=checked(await db.from('rhb_records').select('payload').eq('dataset_id',dataset_id).order('source_row')).map(r=>r.payload);
  const input=buildReportInput({company:team?.name??'This company',mode:flags.some(f=>f.source?.file)?'source':'internal',summary:summarize(sheet,flags.map(f=>({...f,status:f.review_status}))),flags});

  if(!checked(await db.rpc('rhb_ai_take',{kind:'report',daily_max:LIMITS.report}))){
    res.setHeader?.('Retry-After',String(secondsToMidnightET()));
    fail(429,'ai_limit','Daily AI report limit reached. Try again tomorrow.');
  }
  let ai_report;
  try{ai_report=await writeReport(input);}
  catch(e){
    if(!(e instanceof AiError))throw e;
    console.error('AI report failed:',e.message); // message from the SDK never contains the key
    fail(502,'ai_failed','The AI could not finish the report. Try again in a moment.');
  }
  checked(await db.from('rhb_datasets').update({ai_report}).eq('id',dataset_id));
  send(res,201,{data:{ai_report}});
});
