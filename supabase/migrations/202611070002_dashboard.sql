-- Dashboard: AI report column, append-only company data, AI daily limit, add/list members by email.
-- Run once, after the baseline and checker migrations. No service-role key is needed.
alter table public.rhb_datasets add column ai_report jsonb;

-- Append-only true copy: rows of a 'company data' dataset can't be updated or deleted directly.
-- Deletes caused by deleting the team or dataset run inside the foreign-key trigger (depth > 1) and still work.
create function public.rhb_company_rows_locked() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' and pg_trigger_depth()>1 then return old;end if;
 if exists(select 1 from public.rhb_datasets d where d.id=old.dataset_id and d.source='company data') then
  raise exception 'Company data rows are append-only' using errcode='42501';
 end if;
 if tg_op='DELETE' then return old;end if;
 return new;
end $$;
create trigger rhb_records_append_only before update or delete on public.rhb_records
 for each row execute function public.rhb_company_rows_locked();
create function public.rhb_company_source_locked() returns trigger language plpgsql set search_path='' as $$
begin
 if old.source='company data' then
  if tg_op='DELETE' then
   if pg_trigger_depth()>1 then return old;end if; -- team cascade
   raise exception 'Company data cannot be removed' using errcode='42501';
  end if;
  if new.source is distinct from old.source then
   raise exception 'Company data source cannot change' using errcode='42501';
  end if;
 end if;
 if tg_op='DELETE' then return old;end if;
 return new;
end $$;
create trigger rhb_datasets_source_locked before update or delete on public.rhb_datasets
 for each row execute function public.rhb_company_source_locked();

-- AI rate limit: nobody reads or edits the counter directly; rhb_ai_take is the only way in.
create table public.rhb_ai_usage(
 user_id uuid not null, day date not null, kind text not null check(kind in ('report','chat')),
 calls int not null default 0, primary key(user_id,day,kind)
);
alter table public.rhb_ai_usage enable row level security;
revoke all on public.rhb_ai_usage from public, anon, authenticated;
create function public.rhb_ai_take(kind text, daily_max int) returns boolean language plpgsql security definer set search_path='' as $$
declare n int;
begin
 if auth.uid() is null then raise exception 'Not signed in' using errcode='28000';end if;
 if daily_max<1 then return false;end if;
 insert into public.rhb_ai_usage as u(user_id,day,kind,calls)
  values(auth.uid(),(now() at time zone 'America/New_York')::date,kind,1)
  on conflict on constraint rhb_ai_usage_pkey do update set calls=u.calls+1 where u.calls<daily_max
  returning u.calls into n;
 return found;
end $$;

-- Owner adds a member by login email; returns only the user id.
create function public.rhb_add_member(t uuid, member_email text) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid;
begin
 if not public.rhb_owner(t) then raise exception 'Only the company owner can add members' using errcode='42501';end if;
 select u.id into uid from auth.users u where lower(u.email)=lower(trim(member_email));
 if uid is null then raise exception 'No login with that email. Create it in Supabase first.' using errcode='P0002';end if;
 insert into public.rhb_members(team_id,user_id) values(t,uid) on conflict do nothing;
 return uid;
end $$;

-- Owner lists the company's people (owner first, then members).
create function public.rhb_team_members(t uuid) returns table(user_id uuid, email text, is_owner boolean)
language plpgsql security definer set search_path='' as $$
begin
 if not public.rhb_owner(t) then raise exception 'Only the company owner can list members' using errcode='42501';end if;
 return query
  select u.id, u.email::text, (u.id=tm.owner_id)
  from public.rhb_teams tm
  join auth.users u on u.id=tm.owner_id or u.id in(select m.user_id from public.rhb_members m where m.team_id=t)
  where tm.id=t order by (u.id=tm.owner_id) desc, u.email;
end $$;

revoke execute on function public.rhb_ai_take(text,int),public.rhb_add_member(uuid,text),public.rhb_team_members(uuid) from public, anon;
grant execute on function public.rhb_ai_take(text,int),public.rhb_add_member(uuid,text),public.rhb_team_members(uuid) to authenticated;
