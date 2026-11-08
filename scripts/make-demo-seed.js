// Builds public/demo/seed.json: the companies a demo login starts with (npm run demo:seed).
// Every flag and number comes from the same checker code the live app runs, on the repo's own data files.
// Run it again whenever the checker or these files change.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseCSV} from '../lib/csv.js';
import {checkSheet,loadSource,SHEET_COLUMNS} from '../lib/checker.js';
import {summarize} from '../lib/summary.js';
import {computed} from '../api/company-data.js';

const read=f=>parseCSV(fs.readFileSync(new URL(`../${f}`,import.meta.url),'utf8'));
export function buildSeed(){
  let n=0;
  const id=()=>`00000000-0000-4000-8000-${(++n).toString(16).padStart(12,'0')}`; // fixed, uuid-shaped ids so the file is the same every run
  const teams=[],datasets=[],findings=[];
  
  function company(name,extra={}){const t={id:id(),name,...extra};teams.push(t);return t;}
  function companyData(team,file,at){
    const rows=read(file).map((payload,i)=>({record_key:payload.record_id,source_row:i+2,payload,computed:computed(payload)}));
    datasets.push({id:id(),team_id:team.id,name:'Company data',source:'company data',created_at:at,rows});
    return rows.map(r=>r.payload);
  }
  function upload(team,file,copy,at){
    const rows=read(file),flags=checkSheet(rows,copy?loadSource(copy,{file:'Company data (true copy)'}):null);
    const {flags:_,...summary}=summarize(rows,flags); // the flag counts are recounted in the browser as people mark flags
    const ds={id:id(),team_id:team.id,name:`${file.split('/').pop()} ${at}`,source:'analyst upload',created_at:at,signoff:null,ai_report:null,mode:copy?'source':'internal',summary};
    datasets.push(ds);
    for(const f of flags)findings.push({id:id(),team_id:team.id,dataset_id:ds.id,review_status:'open',note:null,flag:f,method:'deterministic',rule:f.type,created_at:at});
  }
  
  // US Postal Service starts empty: the Analysis page offers the real USPS FY2006 file to upload.
  company('US Postal Service (FY2006)',{sample:'usps'});
  const nw=company('Northwind Holdings');
  const nwCopy=companyData(nw,'data/monthly_financials.csv','2026-11-07T14:00:00.000Z');
  upload(nw,'data/synthetic/analyst-sheet-errors.csv',nwCopy,'2026-11-07T15:00:00.000Z');
  upload(nw,'data/synthetic/analyst-sheet-clean.csv',nwCopy,'2026-11-07T16:00:00.000Z');
  const fb=company('Fabrikam Group (2,400 rows)');
  const fbCopy=companyData(fb,'data/synthetic/large/company-data.csv','2026-11-07T14:00:00.000Z');
  upload(fb,'data/synthetic/large/analyst-sheet-errors.csv',fbCopy,'2026-11-07T15:30:00.000Z');
  upload(fb,'data/synthetic/large/analyst-sheet-clean.csv',fbCopy,'2026-11-07T16:30:00.000Z');

return {editable:SHEET_COLUMNS.slice(4),teams,datasets,findings};
}

export const SEED_FILE=new URL('../public/demo/seed.json',import.meta.url);
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
const out=SEED_FILE,{teams,datasets,findings}=buildSeed();
fs.mkdirSync(new URL('.',out),{recursive:true});
fs.writeFileSync(out,JSON.stringify({editable:SHEET_COLUMNS.slice(4),teams,datasets,findings}));
console.log(`Wrote public/demo/seed.json: ${teams.length} companies, ${datasets.length} datasets, ${findings.length} flags, ${(fs.statSync(out).size/1e6).toFixed(2)} MB`);
}
