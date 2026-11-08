import {authenticate} from '../lib/supabase.js';
// Tests replace deps.authenticate so no network is needed.
export const deps={authenticate};
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ApiError extends Error{constructor(status,code,message,details){super(message);this.status=status;this.code=code;this.details=details;}}
export const fail=(status,code,message,details)=>{throw new ApiError(status,code,message,details);};

// Like lib/supabase.js checked(), but maps Postgres codes to HTTP errors: 42501 -> 403, P0002 -> 404, P0001/23505 -> 409.
const PG={'42501':[403,'forbidden'],P0002:[404,'not_found'],P0001:[409,'conflict'],'22023':[422,'invalid_request'],'23505':[409,'conflict']};
export function checked({data,error}){
  if(error){const m=PG[error.code];if(m)fail(m[0],m[1],error.message);throw Error(error.message);}
  return data;
}

export function send(res,status,body){res.status(status).json(body);}

export async function readBody(req,max=2_000_000){
  let b=req.body;
  if(b===undefined){const parts=[];let n=0;for await(const c of req){n+=c.length;if(n>max)fail(413,'too_large','Request body is too large.');parts.push(c);}b=Buffer.concat(parts).toString('utf8');}
  if(typeof b==='string'){if(!b.trim())return {};try{b=JSON.parse(b);}catch{fail(422,'invalid_json','Request body must be valid JSON.');}}
  if(!b||typeof b!=='object'||Array.isArray(b))fail(422,'invalid_json','Request body must be a JSON object.');
  return b;
}

// Returns {db, token}: db is scoped to the signed-in user (publishable key + their token, so RLS applies).
export async function auth(req){
  const m=/^Bearer\s+(\S+)$/i.exec(req.headers?.authorization||'');
  if(!m)fail(401,'unauthorized','Sign in to use this service.');
  try{return {db:await deps.authenticate(m[1]),token:m[1]};}
  catch(e){if(/^Configure /.test(e.message))throw e;fail(401,'unauthorized','Your session is invalid or expired. Sign in again.');}
}

// Wraps a handler: method check, then error mapping (500 hides the real error).
export const route=(methods,fn)=>async function handler(req,res){
  try{
    if(!methods.includes(req.method)){res.setHeader?.('Allow',methods.join(', '));fail(405,'method_not_allowed',`Use ${methods.join(' or ')}.`);}
    await fn(req,res);
  }catch(e){
    if(e instanceof ApiError)return send(res,e.status,{error:{code:e.code,message:e.message,...(e.details?{details:e.details}:{})}});
    if(e?.name==='ValidationError')return send(res,422,{error:{code:'invalid_sheet',message:e.message,details:e.details}});
    console.error(e);
    send(res,500,{error:{code:'server_error',message:'Something went wrong on our side. Try again.'}});
  }
};

export const flagRow=r=>({id:r.id,review_status:r.review_status,decision:r.review_status==='confirmed'?'corrected':r.review_status==='dismissed'?'no_change_needed':null,note:r.note,...r.flag});

// RLS shows a non-member no team row, so absence means "not yours".
export async function requireMember(db,team_id){
  if(!checked(await db.from('rhb_teams').select('id').eq('id',team_id).maybeSingle()))fail(403,'forbidden','You are not a member of that team.');
}

// Supabase sends at most 1,000 rows per request, so saved rows are read in pages.
const PAGE=1000;
export async function readRecords(db,select,where){
  const out=[];
  for(let from=0;;from+=PAGE){
    let q=db.from('rhb_records').select(select);for(const [c,v] of Object.entries(where))q=q.eq(c,v);
    const page=checked(await q.order('source_row').range(from,from+PAGE-1));out.push(...page);
    if(page.length<PAGE)return out;
  }
}

// The company's true copy: its append-only 'company data' dataset and rows in the order they were added.
export async function trueCopy(db,team_id){
  const dataset=checked(await db.from('rhb_datasets').select('id').eq('team_id',team_id).eq('source','company data').maybeSingle());
  const records=dataset?await readRecords(db,'record_key,source_row,payload',{dataset_id:dataset.id}):[];
  return {dataset,records};
}
