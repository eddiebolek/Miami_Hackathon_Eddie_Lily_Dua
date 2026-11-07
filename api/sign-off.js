import {checked} from '../lib/supabase.js';
import {route,auth,readBody,fail,send,UUID} from './_lib.js';

export default route(['POST'],async(req,res)=>{
  const {db,token}=await auth(req);
  const {dataset_id,recheck_dataset_id,note}=await readBody(req);
  const bad=[];
  if(!UUID.test(dataset_id||''))bad.push('dataset_id must be a uuid.');
  if(recheck_dataset_id!=null&&!UUID.test(recheck_dataset_id))bad.push('recheck_dataset_id must be a uuid.');
  if(note!=null&&(typeof note!=='string'||note.length>1000))bad.push('note must be text, 1000 characters or fewer.');
  if(bad.length)fail(422,'invalid_request',bad.join(' '),bad.map(message=>({message})));
  if(!checked(await db.from('rhb_datasets').select('id').eq('id',dataset_id).maybeSingle()))fail(404,'not_found','Check not found, or you are not a member of its team.');
  const flags=checked(await db.from('rhb_findings').select('review_status').eq('dataset_id',dataset_id));
  const open=flags.filter(f=>f.review_status==='open').length;
  if(open)fail(409,'flags_open',`${open} flag${open>1?'s are':' is'} still open. Mark each one corrected or no change needed first.`);
  let recheck_flag_count=null;
  // An unknown re-check id must not read as "0 flags".
  if(recheck_dataset_id&&!checked(await db.from('rhb_datasets').select('id').eq('id',recheck_dataset_id).maybeSingle()))fail(404,'not_found','Re-check not found.');
  if(recheck_dataset_id)recheck_flag_count=checked(await db.from('rhb_findings').select('id').eq('dataset_id',recheck_dataset_id)).length;
  const {data:{user}}=await db.auth.getUser(token);
  const signoff={by:user.id,email:user.email,at:new Date().toISOString(),note:note?.trim()||null,recheck_dataset_id:recheck_dataset_id||null,recheck_flag_count};
  checked(await db.from('rhb_datasets').update({signoff}).eq('id',dataset_id));
  send(res,200,{data:{dataset_id,signoff}});
});
