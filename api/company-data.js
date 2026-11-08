import {parseCSV} from '../lib/csv.js';
import {applyMapping} from '../lib/mapping.js';
import {checkSheet,validateSheet} from '../lib/checker.js';
import {minor,amount,divideRound} from '../lib/finance.js';
import {route,auth,readBody,fail,send,checked,requireMember,trueCopy,UUID} from './_lib.js';

// Append-only: this file only reads and inserts. Nothing here updates or deletes company data.
export default route(['GET','POST'],async(req,res)=>{
  const {db}=await auth(req);
  if(req.method==='POST')return add(db,req,res);
  const team=new URL(req.url||'/','http://x').searchParams.get('team_id');
  if(!UUID.test(team||''))fail(422,'invalid_request','team_id (uuid) is required.');
  const {dataset,records}=await trueCopy(db,team);
  send(res,200,{data:{dataset_id:dataset?.id??null,rows:records.map(r=>({...r.payload,record_id:r.record_key,source_row:r.source_row,computed:computed(r.payload)})),updated_at:new Date().toISOString()}});
});

// Every number here is exact BigInt cents from lib/; the page never does this math.
export function computed(r){
  const out={};
  for(const n of ['revenue','opex']){
    const b=r[`budget_${n}_usd`];
    if(b==null||b===''){out[`${n}_variance_usd`]=out[`${n}_variance_pct`]=null;continue;} // no budget, no variance
    const exp=minor(r[`${n}_usd`])-minor(r[`budget_${n}_usd`]),bv=minor(r[`budget_${n}_usd`]);
    out[`${n}_variance_usd`]=amount(exp);
    out[`${n}_variance_pct`]=bv===0n?null:amount(divideRound(exp*10000n,bv));
  }
  const [o,rc,p,x,f]=['opening_cash_usd','cash_receipts_usd','cash_operating_payments_usd','capex_usd','financing_usd'].map(c=>minor(r[c]));
  out.rollforward_ok=o+rc-p-x+f===minor(r.closing_cash_usd);
  return out;
}

async function add(db,req,res){
  const {team_id,filename,csv,confirm,mapping}=await readBody(req);
  const bad=[];
  if(!UUID.test(team_id||''))bad.push('team_id must be a uuid.');
  if(typeof filename!=='string'||!filename.trim()||filename.length>200)bad.push('filename must be 1 to 200 characters.');
  if(typeof csv!=='string'||!csv.trim()||Buffer.byteLength(csv)>1_000_000)bad.push('csv must be text, 1 MB or less.');
  if(confirm!==undefined&&typeof confirm!=='boolean')bad.push('confirm must be true or false.');
  if(mapping!==undefined&&(!mapping||typeof mapping!=='object'||Array.isArray(mapping)))bad.push('mapping must be an object.');
  if(bad.length)fail(422,'invalid_request',bad.join(' '),bad.map(message=>({message})));
  let rows;
  try{rows=parseCSV(csv);}catch(e){fail(422,'invalid_sheet',`Could not read the file as CSV: ${e.message}`,[{row:null,column:null,message:e.message}]);}
  if(mapping)rows=applyMapping(rows,mapping); // ValidationError -> 422 with details
  checkNewRows(rows);
  await requireMember(db,team_id);
  const {dataset,records}=await trueCopy(db,team_id);
  const {new_rows,warnings}=planAdd(rows,records);
  if(confirm!==true)return send(res,200,{data:{count:rows.length,new_rows,warnings}});
  const ds=dataset??checked(await db.from('rhb_datasets').insert({team_id,name:'Company data',source:'company data'}).select('id').single());
  // One plain insert (never upsert): a repeated record_key is rejected by the database (23505 -> 409) and nothing is written.
  checked(await db.from('rhb_records').insert(new_rows.map(({source_row,...payload})=>({team_id,dataset_id:ds.id,record_key:payload.record_id,source_row,payload}))));
  send(res,201,{data:{added:rows.length,dataset_id:ds.id}});
}

// The two checks below need no database, so the demo login (api/demo.js) runs exactly the same code.
// The file on its own: valid columns and amounts, no totals rows, no repeated month.
export function checkNewRows(rows){
  validateSheet(rows,null); // ValidationError -> 422 with details
  const dup=[],seenId=new Set(),seenKey=new Set();
  rows.forEach((r,i)=>{
    if(r.period==='TOTAL')dup.push({row:i+2,column:'period',message:'Totals rows cannot be added to company data.'});
    const k=`${r.company_id}|${r.period}`;
    if(seenId.has(r.record_id)||seenKey.has(k))dup.push({row:i+2,column:'record_id',message:`${r.record_id} (${r.company_id} ${r.period}) appears more than once in this file.`});
    seenId.add(r.record_id);seenKey.add(k);
  });
  if(dup.length)fail(422,'invalid_sheet',`Row ${dup[0].row}: ${dup[0].message}`,dup);
}

// Against the saved rows ({record_key, source_row, payload}): nothing already saved may come back, and
// warnings = flags that appear only because of the new rows (e.g. a January opening that does not match December's closing).
export function planAdd(rows,records){
  const have=records.map(r=>r.payload);
  const ids=new Set(records.map(r=>r.record_key)),keys=new Set(have.map(r=>`${r.company_id}|${r.period}`));
  const clash=rows.map((r,i)=>({r,i})).filter(({r})=>ids.has(r.record_id)||keys.has(`${r.company_id}|${r.period}`))
    .map(({r,i})=>({row:i+2,column:'record_id',message:`${r.record_id} (${r.company_id} ${r.period}) is already in the company data. Existing rows are never changed.`}));
  if(clash.length)fail(409,'already_exists',`${clash.length} row${clash.length>1?'s are':' is'} already in the company data. Nothing was added.`,clash);
  const before=new Set((have.length?checkSheet(have,null):[]).map(f=>f.key));
  const warnings=checkSheet([...have,...rows],null).filter(f=>!before.has(f.key));
  const first=(records.at(-1)?.source_row??1)+1;
  return {new_rows:rows.map((r,i)=>({...r,source_row:first+i})),warnings};
}
