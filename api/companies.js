import {route,auth,readBody,fail,send,checked,UUID} from './_lib.js';

// GET: the companies this login can see (a developer sees all) with their role in each.
// POST: developer-only; creates a company and names its first admin by login email.
export default route(['GET','POST'],async(req,res)=>{
  const {db}=await auth(req);
  if(req.method==='GET'){
    const [{data:{user}},isDev,teams]=await Promise.all([db.auth.getUser(),db.rpc('rhb_is_dev'),db.from('rhb_teams').select('id,name,owner_id').order('name')]);
    const is_dev=checked(isDev)===true,rows=checked(teams);
    const mine=new Map(checked(await db.from('rhb_members').select('team_id,role').eq('user_id',user.id)).map(m=>[m.team_id,m.role]));
    return send(res,200,{is_dev,companies:rows.map(t=>({id:t.id,name:t.name,my_role:is_dev?'developer':t.owner_id===user.id?'admin':mine.get(t.id)||'analyst'}))});
  }
  const {name,admin_email}=await readBody(req);
  const bad=[];
  if(typeof name!=='string'||!name.trim()||name.trim().length>100)bad.push('name must be 1 to 100 characters.');
  if(typeof admin_email!=='string'||!/^[^@\s]+@[^@\s]+$/.test(admin_email.trim())||admin_email.length>254)bad.push('admin_email must be a valid email address.');
  if(bad.length)fail(422,'invalid_request',bad.join(' '),bad.map(message=>({message})));
  send(res,201,{data:{id:checked(await db.rpc('rhb_create_company',{company_name:name.trim(),admin_email:admin_email.trim()}))}});
});
