import {route,auth,readBody,fail,send,checked,UUID} from './_lib.js';

// Both go through owner-only database functions; a non-owner gets 403 and an unknown email 404 from their error codes.
export default route(['GET','POST'],async(req,res)=>{
  const {db}=await auth(req);
  if(req.method==='GET'){
    const team=new URL(req.url||'/','http://x').searchParams.get('team_id');
    if(!UUID.test(team||''))fail(422,'invalid_request','team_id (uuid) is required.');
    return send(res,200,{data:checked(await db.rpc('rhb_team_members',{t:team}))});
  }
  const {team_id,email}=await readBody(req);
  const bad=[];
  if(!UUID.test(team_id||''))bad.push('team_id must be a uuid.');
  if(typeof email!=='string'||!/^[^@\s]+@[^@\s]+$/.test(email.trim())||email.length>254)bad.push('email must be a valid email address.');
  if(bad.length)fail(422,'invalid_request',bad.join(' '),bad.map(message=>({message})));
  send(res,201,{data:{user_id:checked(await db.rpc('rhb_add_member',{t:team_id,member_email:email.trim()}))}});
});
