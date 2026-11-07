import {parseCSV} from '../lib/csv.js';
import {checkSheet} from '../lib/checker.js';
import {importRows,checked} from '../lib/supabase.js';
import {route,auth,readBody,fail,send,flagRow,UUID} from './_lib.js';

export default route(['GET','POST'],async(req,res)=>{
  const {db}=await auth(req);
  if(req.method==='POST')return create(db,req,res);
  const q=new URL(req.url||'/','http://x').searchParams;
  if(q.get('dataset_id')){
    const id=q.get('dataset_id');
    if(!UUID.test(id))fail(422,'invalid_request','dataset_id must be a uuid.');
    const dataset=checked(await db.from('rhb_datasets').select('id,name,created_at,signoff').eq('id',id).maybeSingle());
    if(!dataset)fail(404,'not_found','Check not found.');
    const rows=checked(await db.from('rhb_findings').select('id,review_status,note,flag').eq('dataset_id',id).order('created_at'));
    return send(res,200,{data:{dataset,flags:rows.map(flagRow)}});
  }
  const team=q.get('team_id');
  if(!UUID.test(team||''))fail(422,'invalid_request','team_id (uuid) or dataset_id is required.');
  const sets=checked(await db.from('rhb_datasets').select('id,name,created_at,signoff').eq('team_id',team).eq('source','analyst upload').order('created_at',{ascending:false}).limit(50));
  const fl=sets.length?checked(await db.from('rhb_findings').select('dataset_id,review_status').in('dataset_id',sets.map(s=>s.id))):[];
  send(res,200,{data:sets.map(s=>{const mine=fl.filter(f=>f.dataset_id===s.id);return {dataset_id:s.id,name:s.name,created_at:s.created_at,flag_count:mine.length,open_count:mine.filter(f=>f.review_status==='open').length,signoff:s.signoff};})});
});

async function create(db,req,res){
  const {team_id,filename,csv}=await readBody(req);
  const bad=[];
  if(!UUID.test(team_id||''))bad.push('team_id must be a uuid.');
  if(typeof filename!=='string'||!filename.trim()||filename.length>200)bad.push('filename must be 1 to 200 characters.');
  if(typeof csv!=='string'||!csv.trim()||Buffer.byteLength(csv)>1_000_000)bad.push('csv must be text, 1 MB or less.');
  if(bad.length)fail(422,'invalid_request',bad.join(' '),bad.map(message=>({message})));
  let rows;
  try{rows=parseCSV(csv);}catch(e){fail(422,'invalid_sheet',`Could not read the file as CSV: ${e.message}`,[{row:null,column:null,message:e.message}]);}
  const flags=checkSheet(rows); // throws ValidationError -> 422 with details
  // RLS: a non-member sees no team row.
  if(!checked(await db.from('rhb_teams').select('id').eq('id',team_id).maybeSingle()))fail(403,'forbidden','You are not a member of that team.');
  const name=`${filename.trim()} ${new Date().toISOString()}`;
  // importRows upserts on record_id, so a repeated id (a duplicate_row flag) would abort the save; give repeats a unique key.
  const seen=new Set();
  const {dataset_id}=await importRows(db,team_id,name,rows.map((r,i)=>seen.has(r.record_id)?{...r,record_id:`${r.record_id} (duplicate, row ${i+2})`}:(seen.add(r.record_id),r)));
  checked(await db.from('rhb_datasets').update({source:'analyst upload'}).eq('id',dataset_id));
  let saved=[];
  if(flags.length)saved=checked(await db.from('rhb_findings').insert(flags.map(f=>({team_id,dataset_id,title:`${f.cell}: ${f.type.replace(/_/g,' ')}`,detail:f.explanation,rule:f.type,severity:f.severity,method:'deterministic',flag:f}))).select('id,review_status,note,flag'));
  send(res,201,{data:{dataset_id,flag_count:flags.length,flags:saved.map(flagRow)}});
}
