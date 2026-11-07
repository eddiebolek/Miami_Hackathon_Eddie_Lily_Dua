import Anthropic from '@anthropic-ai/sdk';
import {route,auth,readBody,fail,send,checked,requireMember,UUID} from './_lib.js';
import {suggestMapping} from '../lib/mapping.js';
import {aiEnabled,deps,LIMITS,AiError} from '../lib/ai.js';

// Code matches the headers first. Only if columns are still unmatched does the AI see the header NAMES (never any values).
export default route(['POST'],async(req,res)=>{
  const {db}=await auth(req);
  const {team_id,headers,sample_rows}=await readBody(req);
  const bad=[];
  if(!UUID.test(team_id||''))bad.push('team_id must be a uuid.');
  if(!Array.isArray(headers)||!headers.length||headers.length>60||headers.some(h=>typeof h!=='string'||!h||h.length>100))bad.push('headers must be 1 to 60 names of up to 100 characters.');
  if(sample_rows!==undefined&&(!Array.isArray(sample_rows)||sample_rows.length>3))bad.push('sample_rows can hold at most 3 rows.');
  if(bad.length)fail(422,'invalid_request',bad.join(' '));
  await requireMember(db,team_id);
  const {mapping,unmatched}=suggestMapping(headers);
  const ai=[];
  const free=headers.filter(h=>mapping[h]===null);
  if(unmatched.length&&free.length&&aiEnabled()&&checked(await db.rpc('rhb_ai_take',{kind:'chat',daily_max:LIMITS.chat}))){
    try{
      const client=deps.client??=new Anthropic();
      const r=await client.messages.create({model:process.env.AI_MAP_MODEL||'claude-haiku-5-5',max_tokens:600,
        system:'You match spreadsheet header names to a fixed list of column names. Reply with only a JSON object whose keys are header names and whose values are one column name from the list, or null. Use each column name at most once. Only match when the meaning is clearly the same.',
        messages:[{role:'user',content:JSON.stringify({headers:free,columns:unmatched})}]});
      const text=r.content?.find(b=>b.type==='text')?.text??'',guess=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
      const open=new Set(unmatched);
      for(const h of free){const c=guess?.[h];if(typeof c==='string'&&open.has(c)){mapping[h]=c;open.delete(c);ai.push(h);}} // anything not on our list is dropped
      unmatched.splice(0,unmatched.length,...open);
    }catch(e){console.error('AI column matching failed:',e instanceof AiError?e.message:e?.message);} // fall back to the code suggestion
  }
  send(res,200,{data:{mapping,unmatched,ai}});
});
