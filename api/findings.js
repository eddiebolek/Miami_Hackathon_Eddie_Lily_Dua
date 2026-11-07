import {SHEET_COLUMNS} from '../lib/checker.js';
import {route,auth,readBody,fail,send,flagRow,checked,requireMember,trueCopy,UUID} from './_lib.js';

const STATUS={corrected:'confirmed',no_change_needed:'dismissed'};
const EDITABLE=SHEET_COLUMNS.slice(4); // the 14 money and cash columns
const REVIEW=['open','confirmed','dismissed'];
const bad422=bad=>{if(bad.length)fail(422,'invalid_request',bad.join(' '),bad.map(message=>({message})));};

export default route(['GET','POST','PATCH'],async(req,res)=>{
  const {db,token}=await auth(req);
  if(req.method==='GET')return list(db,req,res);
  if(req.method==='POST')return suggest(db,token,req,res);
  const id=new URL(req.url||'/','http://x').searchParams.get('id');
  if(!UUID.test(id||''))fail(422,'invalid_request','id (uuid) is required.');
  const {decision,note}=await readBody(req);
  const bad=[];
  if(!STATUS[decision])bad.push('decision must be "corrected" or "no_change_needed".');
  if(note!==undefined&&note!==null&&typeof note!=='string')bad.push('note must be text.');
  if(typeof note==='string'&&note.length>1000)bad.push('note must be 1000 characters or fewer.');
  if(decision==='no_change_needed'&&!(typeof note==='string'&&note.trim()))bad.push('A note is required when no change is needed.');
  if(bad.length)fail(422,'invalid_request',bad.join(' '),bad.map(message=>({message})));
  const rows=checked(await db.from('rhb_findings').update({review_status:STATUS[decision],note:note?.trim()||null}).eq('id',id).select('id,review_status,note,flag'));
  // RLS hides other teams' rows, so "unknown" and "not yours" look the same.
  if(!rows.length)fail(404,'not_found','Flag not found, or you are not a member of its team.');
  send(res,200,{data:flagRow(rows[0])});
});

// Flags and suggested edits share rhb_findings; method tells them apart (a suggestion never changes data).
async function list(db,req,res){
  const q=new URL(req.url||'/','http://x').searchParams;
  const [team,status,kind,dataset]=['team_id','status','kind','dataset_id'].map(k=>q.get(k));
  const bad=[];
  if(!UUID.test(team||''))bad.push('team_id (uuid) is required.');
  if(status&&!REVIEW.includes(status))bad.push(`status must be one of ${REVIEW.join(', ')}.`);
  if(kind&&!['flag','suggestion'].includes(kind))bad.push('kind must be "flag" or "suggestion".');
  if(dataset&&!UUID.test(dataset))bad.push('dataset_id must be a uuid.');
  bad422(bad);
  let r=db.from('rhb_findings').select('id,review_status,note,flag,dataset_id,created_at').eq('team_id',team);
  if(status)r=r.eq('review_status',status);
  if(dataset)r=r.eq('dataset_id',dataset);
  if(kind)r=kind==='flag'?r.eq('method','deterministic'):r.eq('rule','suggested_edit');
  const rows=checked(await r.order('created_at',{ascending:false}).limit(500));
  send(res,200,{data:rows.map(x=>({...flagRow(x),dataset_id:x.dataset_id,created_at:x.created_at}))});
}

async function suggest(db,token,req,res){
  const {team_id,record_id,column,proposed_value,reason}=await readBody(req);
  const bad=[];
  if(!UUID.test(team_id||''))bad.push('team_id must be a uuid.');
  if(typeof record_id!=='string'||!record_id.trim()||record_id.length>100)bad.push('record_id must be 1 to 100 characters.');
  if(!EDITABLE.includes(column))bad.push(`column must be one of ${EDITABLE.join(', ')}.`);
  if(typeof proposed_value!=='string'||!(String(column).includes('variance')?/^-?\d+(\.\d{1,2})?$/:/^\d+(\.\d{1,2})?$/).test(proposed_value))bad.push('proposed_value must be a plain amount like 1234.56 (no commas or symbols).');
  if(typeof reason!=='string'||!reason.trim()||reason.length>500)bad.push('reason must be 1 to 500 characters.');
  bad422(bad);
  await requireMember(db,team_id);
  const {dataset,records}=await trueCopy(db,team_id);
  const rec=records.find(r=>r.record_key===record_id);
  if(!rec)fail(404,'not_found',`Record ${record_id} is not in this company's data.`);
  const {data:{user}}=await db.auth.getUser(token);
  const flag={kind:'suggested_edit',record_id,source_row:rec.source_row,column,current_value:rec.payload[column]??null,proposed_value,reason:reason.trim(),by_email:user.email};
  const saved=checked(await db.from('rhb_findings').insert({team_id,dataset_id:dataset.id,title:`Suggested edit: ${record_id} ${column}`,detail:flag.reason,rule:'suggested_edit',severity:'low',method:'human',flag}).select('id,review_status,note,flag,dataset_id,created_at'));
  send(res,201,{data:{...flagRow(saved[0]),dataset_id:saved[0].dataset_id,created_at:saved[0].created_at}});
}
