-- Roles: platform developers (rhb_devs), per-company admin/analyst, and company creation by developers only.
-- Run once, after the baseline, checker and dashboard migrations. No service-role key is needed.
-- To make yourself a developer, run in the SQL editor:
--   insert into public.rhb_devs(user_id) select id from auth.users where lower(email)=lower('you@example.com');

create table public.rhb_devs(user_id uuid primary key references auth.users(id) on delete cascade);
alter table public.rhb_devs enable row level security;
revoke all on public.rhb_devs from public, anon, authenticated;

create function public.rhb_is_dev() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.rhb_devs where user_id=auth.uid());
$$;

alter table public.rhb_members add column role text not null default 'analyst' check(role in ('admin','analyst'));

-- Developers count as members of every company, so every existing team policy widens to them (and no one else).
create or replace function public.rhb_member(t uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.rhb_teams where id=t and owner_id=auth.uid()) or
 exists(select 1 from public.rhb_members where team_id=t and user_id=auth.uid()) or public.rhb_is_dev();
$$;
create function public.rhb_admin(t uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.rhb_owner(t) or public.rhb_is_dev() or
 exists(select 1 from public.rhb_members where team_id=t and user_id=auth.uid() and role='admin');
$$;

-- Only rhb_create_company may create a company.
drop policy teams_create on public.rhb_teams;
revoke insert on public.rhb_teams from authenticated;

create function public.rhb_create_company(company_name text, admin_email text) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid; tid uuid;
begin
 if not public.rhb_is_dev() then raise exception 'Only a developer can create a company' using errcode='42501';end if;
 select u.id into uid from auth.users u where lower(u.email)=lower(trim(admin_email));
 if uid is null then raise exception 'No login with that email. Create it in Supabase first.' using errcode='P0002';end if;
 insert into public.rhb_teams(name,owner_id) values(trim(company_name),uid) returning id into tid;
 insert into public.rhb_members(team_id,user_id,role) values(tid,uid,'admin');
 return tid;
end $$;

-- Member management is now for admins (owner, company admins, developers).
drop function public.rhb_add_member(uuid,text);
create function public.rhb_add_member(t uuid, member_email text, member_role text default 'analyst') returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid;
begin
 if not public.rhb_admin(t) then raise exception 'Only a company admin can add members' using errcode='42501';end if;
 if member_role not in ('admin','analyst') then raise exception 'Role must be admin or analyst' using errcode='22023';end if;
 select u.id into uid from auth.users u where lower(u.email)=lower(trim(member_email));
 if uid is null then raise exception 'No login with that email. Create it in Supabase first.' using errcode='P0002';end if;
 insert into public.rhb_members(team_id,user_id,role) values(t,uid,member_role) on conflict do nothing;
 return uid;
end $$;

drop function public.rhb_team_members(uuid);
create function public.rhb_team_members(t uuid) returns table(user_id uuid, email text, is_owner boolean, role text)
language plpgsql security definer set search_path='' as $$
begin
 if not public.rhb_admin(t) then raise exception 'Only a company admin can list members' using errcode='42501';end if;
 return query
  select u.id, u.email::text, (u.id=tm.owner_id), case when u.id=tm.owner_id then 'admin' else coalesce((select m.role from public.rhb_members m where m.team_id=t and m.user_id=u.id),'analyst') end
  from public.rhb_teams tm
  join auth.users u on u.id=tm.owner_id or u.id in(select m.user_id from public.rhb_members m where m.team_id=t)
  where tm.id=t order by (u.id=tm.owner_id) desc, u.email;
end $$;

create function public.rhb_remove_member(t uuid, member_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare r text;
begin
 if not public.rhb_admin(t) then raise exception 'Only a company admin can remove members' using errcode='42501';end if;
 if exists(select 1 from public.rhb_teams where id=t and owner_id=member_id) then raise exception 'The company owner cannot be removed' using errcode='P0001';end if;
 select role into r from public.rhb_members where team_id=t and user_id=member_id;
 if r is null then raise exception 'That person is not in this company' using errcode='P0002';end if;
 if r='admin' and (select count(*) from public.rhb_members where team_id=t and role='admin')<2 then raise exception 'A company needs at least one admin' using errcode='P0001';end if;
 delete from public.rhb_members where team_id=t and user_id=member_id;
end $$;

create function public.rhb_set_role(t uuid, member_id uuid, new_role text) returns void language plpgsql security definer set search_path='' as $$
declare r text;
begin
 if not public.rhb_admin(t) then raise exception 'Only a company admin can change roles' using errcode='42501';end if;
 if new_role not in ('admin','analyst') then raise exception 'Role must be admin or analyst' using errcode='22023';end if;
 if exists(select 1 from public.rhb_teams where id=t and owner_id=member_id) then raise exception 'The company owner is always an admin' using errcode='P0001';end if;
 select role into r from public.rhb_members where team_id=t and user_id=member_id;
 if r is null then raise exception 'That person is not in this company' using errcode='P0002';end if;
 if r='admin' and new_role<>'admin' and (select count(*) from public.rhb_members where team_id=t and role='admin')<2 then raise exception 'A company needs at least one admin' using errcode='P0001';end if;
 update public.rhb_members set role=new_role where team_id=t and user_id=member_id;
end $$;

revoke execute on function public.rhb_is_dev(),public.rhb_admin(uuid),public.rhb_create_company(text,text),public.rhb_add_member(uuid,text,text),public.rhb_team_members(uuid),public.rhb_remove_member(uuid,uuid),public.rhb_set_role(uuid,uuid,text) from public, anon;
grant execute on function public.rhb_is_dev(),public.rhb_admin(uuid),public.rhb_create_company(text,text),public.rhb_add_member(uuid,text,text),public.rhb_team_members(uuid),public.rhb_remove_member(uuid,uuid),public.rhb_set_role(uuid,uuid,text) to authenticated;
