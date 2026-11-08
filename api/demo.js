import {parseCSV} from '../lib/csv.js';
import {applyMapping,suggestMapping} from '../lib/mapping.js';
import {checkSheet,loadSource} from '../lib/checker.js';
import {summarize} from '../lib/summary.js';
import {checkNewRows,planAdd,computed} from './company-data.js';
import {route,readBody,fail,send} from './_lib.js';

// Demo login (username demo, password demo). The browser keeps all demo data in memory (public/demo.js) and sends it
// here only for the exact math, using the same checker code as the real endpoints. No sign-in, no database, no AI:
// nothing is read from or written to any real company, and nothing is kept between requests.
const MAX_ROWS=5000;
const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);
const rowsOk=v=>Array.isArray(v)&&v.length<=MAX_ROWS&&v.every(isObj);

export default route(['POST'],async(req,res)=>{
  const b=await readBody(req,4_500_000); // the 2,400-row demo company plus a 1 MB file; Vercel's own request cap
  if(b.action==='map'){
    const {headers}=b;
    if(!Array.isArray(headers)||!headers.length||headers.length>60||headers.some(h=>typeof h!=='string'||!h||h.length>100))fail(422,'invalid_request','headers must be 1 to 60 names of up to 100 characters.');
    const {mapping,unmatched}=suggestMapping(headers);
    return send(res,200,{data:{mapping,unmatched,ai:[]}});
  }
  if(b.action!=='check'&&b.action!=='add')fail(422,'invalid_request','action must be check, add or map.');
  const {csv,mapping}=b,bad=[];
  if(typeof csv!=='string'||!csv.trim()||Buffer.byteLength(csv)>1_000_000)bad.push('csv must be text, 1 MB or less.');
  if(mapping!=null&&!isObj(mapping))bad.push('mapping must be an object.');
  if(b.action==='check'&&b.copy!=null&&!rowsOk(b.copy))bad.push(`copy must be a list of at most ${MAX_ROWS} rows.`);
  if(b.action==='add'&&!(rowsOk(b.records)&&b.records.every(r=>typeof r.record_key==='string'&&Number.isInteger(r.source_row)&&isObj(r.payload))))bad.push(`records must be a list of at most ${MAX_ROWS} saved rows.`);
  if(bad.length)fail(422,'invalid_request',bad.join(' '),bad.map(message=>({message})));
  let rows;
  try{rows=parseCSV(csv);}catch(e){fail(422,'invalid_sheet',`Could not read the file as CSV: ${e.message}`,[{row:null,column:null,message:e.message}]);}
  if(mapping)rows=applyMapping(rows,mapping); // ValidationError -> 422 with details

  if(b.action==='check'){
    // same rule as api/checks.js: with company data, compare against it; without, run the checks that need only the file
    const copy=b.copy||[];
    const flags=checkSheet(rows,copy.length?loadSource(copy,{file:'Company data (true copy)'}):null);
    return send(res,200,{data:{mode:copy.length?'source':'internal',flags,summary:summarize(rows,flags)}});
  }
  checkNewRows(rows);
  const {new_rows,warnings}=planAdd(rows,b.records);
  send(res,200,{data:{count:rows.length,new_rows,warnings,computed:new_rows.map(({source_row,...r})=>computed(r))}});
});
