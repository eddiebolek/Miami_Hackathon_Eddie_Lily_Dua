// Local preview: serves public/ and runs api/<name>.js handlers (same as Vercel would). Not for production.
import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pub=path.join(root,'public');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};

http.createServer(async(req,res)=>{
  res.status=n=>{res.statusCode=n;return res;};
  res.json=b=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(b));};
  try{
    const url=new URL(req.url,'http://x');
    const api=/^\/api\/([a-z-]+)$/.exec(url.pathname);
    if(api){
      const file=path.join(root,'api',`${api[1]}.js`);
      if(api[1].startsWith('_')||!(await stat(file).catch(()=>null)))return res.status(404).json({error:{code:'not_found',message:'No such endpoint.'}});
      return (await import(pathToFileURL(file))).default(req,res);
    }
    let p=decodeURIComponent(url.pathname);
    if(p.includes('..')||p.includes('\0'))return res.status(400).end('Bad path');
    if(p.endsWith('/'))p+='index.html';
    const file=path.join(pub,p);
    if(!file.startsWith(pub+path.sep))return res.status(400).end('Bad path');
    const body=await readFile(file).catch(()=>null);
    if(!body)return res.status(404).end('Not found');
    res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');
    res.end(body);
  }catch(e){console.error(e);res.status(500).end('Server error');}
}).listen(4190,'127.0.0.1',()=>console.log('Preview at http://127.0.0.1:4190'));
