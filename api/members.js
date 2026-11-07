import {route,auth,readBody,fail,send,checked,UUID} from './_lib.js';

// All four go through admin-only database functions; their error codes become 403 / 404 / 409.
const ROLES=['admin','analyst'];
export default route(['GET','POST','PATCH','DELETE'],async(req,res)=>{
  const {db}=await auth(req);
  const sp=new URL(req.url||'/','http://x').searchParams;
  if(req.method==='GET'||req.method==='DELETE'){
    const team=sp.get('team_id'),user=sp.get('user_id');
    if(!UUID.test(team||''))fail(422,'invalid_request','team_id (uuid) is required.');
    if(req.method==='GET')return send(res,200,{data:checked(await db.rpc('rhb_team_members',{t:team}))});
    if(!UUID.test(user||''))fail(422,'invalid_request','user_id (uuid) is required.');
    checked(await db.rpc('rhb_remove_member',{t:team,member_id:user}));
    return send(res,200,{data:{removed:user}});
  }
  const {team_id,email,user_id,role='analyst'}=await readBody(req);
  const bad=[];
  if(!UUID.test(team_id||''))bad.push('team_id must be a uuid.');
  if(!ROLES.includes(role))bad.push('role must be admin or analyst.');
  if(req.method==='PATCH'){
    if(!UUID.test(user_id||''))bad.push('user_id must be a uuid.');
  }else if(typeof email!=='string'||!/^[^@\s]+@[^@\s]+$/.test(email.trim())||email.length>254)bad.push('email must be a valid email address.');
  if(bad.length)fail(422,'invalid_request',bad.join(' '),bad.map(message=>({message})));
  if(req.method==='PATCH'){
    checked(await db.rpc('rhb_set_role',{t:team_id,member_id:user_id,new_role:role}));
    return send(res,200,{data:{user_id,role}});
  }
  send(res,201,{data:{user_id:checked(await db.rpc('rhb_add_member',{t:team_id,member_email:email.trim(),member_role:role}))}});
});
