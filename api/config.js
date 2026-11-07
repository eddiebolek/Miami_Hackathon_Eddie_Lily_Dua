import {route,send} from './_lib.js';
export default route(['GET'],async(req,res)=>{
  send(res,200,{supabaseUrl:process.env.SUPABASE_URL,publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY});
});
