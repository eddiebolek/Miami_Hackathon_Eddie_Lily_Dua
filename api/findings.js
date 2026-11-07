import {checked} from '../lib/supabase.js';
import {route,auth,readBody,fail,send,flagRow,UUID} from './_lib.js';

const STATUS={corrected:'confirmed',no_change_needed:'dismissed'};
export default route(['PATCH'],async(req,res)=>{
  const {db}=await auth(req);
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
