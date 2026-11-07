import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
// Same Supabase simulation as tests/database.js (auth.uid via a session setting), plus the checker migration.
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;grant usage on schema storage to authenticated;grant select,insert,update,delete on storage.objects to authenticated;`);
for(const f of ['202610050001_baseline','202611070001_checker'])await db.exec(await fs.readFile(new URL(`../supabase/migrations/${f}.sql`,import.meta.url),'utf8'));
const alice='00000000-0000-4000-8000-000000000001',eve='00000000-0000-4000-8000-000000000003';
await db.exec(`insert into auth.users values('${alice}'),('${eve}');`);
async function as(u){await db.exec(`reset role;set role authenticated;set request.jwt.claim.sub='${u}';`);}
let checks=0;const ok=()=>checks++;
await as(alice);
const team=(await db.query("insert into rhb_teams(name) values('Alpha') returning id")).rows[0].id;
const other=(await db.query("insert into rhb_teams(name) values('Other') returning id")).rows[0].id;
const ds=(await db.query(`insert into rhb_datasets(team_id,name,source,signoff) values('${team}','upload1','synthetic','{"by":"alice"}') returning id`)).rows[0].id;ok();
const fid=async()=>(await db.query(`insert into rhb_findings(team_id,title,detail,severity,method,flag,note,dataset_id) values('${team}','t','d','high','deterministic','{"cell":"E2"}','hello','${ds}') returning id`)).rows[0].id;
const f1=await fid(),f2=await fid();ok();
for(const s of['confirmed','dismissed']){assert.equal((await db.query(`update rhb_findings set review_status='${s}',note='done' where id='${s==='confirmed'?f1:f2}' returning id`)).rows.length,1);ok();}
await assert.rejects(db.exec(`update rhb_findings set note='${'x'.repeat(1001)}' where id='${f1}'`));ok();
await assert.rejects(db.exec(`insert into rhb_findings(team_id,title,detail,severity,method,dataset_id) values('${other}','t','d','low','human','${ds}')`));ok();
await as(eve);
assert.equal((await db.query('select * from rhb_findings')).rows.length,0);
assert.equal((await db.query('select * from rhb_datasets')).rows.length,0);
assert.equal((await db.query(`update rhb_findings set review_status='dismissed',note='evil' returning id`)).rows.length,0);
assert.equal((await db.query(`update rhb_datasets set signoff='{"by":"eve"}' returning id`)).rows.length,0);checks+=4;
await assert.rejects(db.exec(`insert into rhb_findings(team_id,title,detail,severity,method,dataset_id) values('${team}','t','d','low','human','${ds}')`));ok();
await as(alice);
assert.equal((await db.query('select review_status,note from rhb_findings order by review_status')).rows.length,2);ok();
await db.exec(`delete from rhb_datasets where id='${ds}'`);
assert.equal((await db.query('select * from rhb_findings')).rows.length,0);ok();
await db.close();console.log(`PASS: ${checks} checker database checks (new columns, confirmed/dismissed, team privacy, cross-team foreign key, cascade). PostgreSQL engine: PGlite; Supabase Auth simulated.`);
