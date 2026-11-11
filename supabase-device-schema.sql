-- Eye Touch Link: cloud sync + per-device approval
-- Run once in Supabase Dashboard > SQL Editor.
-- Uses Supabase Auth user identity. Do NOT expose service_role key in the app.

create table if not exists public.etl_devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  device_name text not null default 'My device',
  platform text not null default 'web',
  status text not null default 'pending' check (status in ('approved','pending','revoked')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  approved_at timestamptz,
  revoked_at timestamptz,
  primary key (user_id, device_id)
);

create table if not exists public.etl_cloud_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.etl_devices enable row level security;
alter table public.etl_cloud_data enable row level security;
revoke all on public.etl_devices from anon, authenticated;
revoke all on public.etl_cloud_data from anon, authenticated;

create or replace function public.etl_register_device(p_device_id text, p_device_name text, p_platform text)
returns text language plpgsql security definer set search_path = public, auth as $$
declare v_status text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if length(coalesce(p_device_id,'')) < 12 then raise exception 'Invalid device id'; end if;
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  select status into v_status from public.etl_devices where user_id=auth.uid() and device_id=p_device_id;
  if found then
    update public.etl_devices set last_seen_at=now(), device_name=left(coalesce(p_device_name,'My device'),80), platform=left(coalesce(p_platform,'web'),40)
      where user_id=auth.uid() and device_id=p_device_id;
    return v_status;
  end if;
  if not exists(select 1 from public.etl_devices where user_id=auth.uid() and status='approved') then
    v_status := 'approved';
  else
    v_status := 'pending';
  end if;
  insert into public.etl_devices(user_id,device_id,device_name,platform,status,approved_at)
  values(auth.uid(),p_device_id,left(coalesce(p_device_name,'My device'),80),left(coalesce(p_platform,'web'),40),v_status,case when v_status='approved' then now() else null end);
  return v_status;
end; $$;

create or replace function public.etl_get_cloud_data(p_device_id text)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare v_payload jsonb; v_updated timestamptz;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists(select 1 from public.etl_devices where user_id=auth.uid() and device_id=p_device_id and status='approved') then raise exception 'Device is not approved'; end if;
  select payload,updated_at into v_payload,v_updated from public.etl_cloud_data where user_id=auth.uid();
  if not found then return null; end if;
  return jsonb_build_object('payload',v_payload,'updated_at',v_updated);
end; $$;

create or replace function public.etl_save_cloud_data(p_device_id text, p_payload jsonb, p_expected_updated_at timestamptz default null)
returns timestamptz language plpgsql security definer set search_path = public, auth as $$
declare v_updated timestamptz; v_current timestamptz;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if coalesce(jsonb_typeof(p_payload), '') <> 'object'
     or coalesce(jsonb_typeof(p_payload->'tx'), '') <> 'array'
     or coalesce(jsonb_typeof(p_payload->'debts'), '') <> 'array' then
    raise exception 'Invalid Eye Touch Link ledger payload';
  end if;
  if octet_length(p_payload::text) > 5242880 then
    raise exception 'Ledger payload exceeds the 5 MB safety limit';
  end if;
  if not exists(select 1 from public.etl_devices where user_id=auth.uid() and device_id=p_device_id and status='approved') then raise exception 'Device is not approved'; end if;
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  select updated_at into v_current from public.etl_cloud_data where user_id=auth.uid() for update;
  if found then
    if p_expected_updated_at is null or p_expected_updated_at <> v_current then raise exception 'CLOUD_CONFLICT: Cloud data changed on another device. Reload before saving.'; end if;
    update public.etl_cloud_data set payload=p_payload,updated_at=now() where user_id=auth.uid() returning updated_at into v_updated;
  else
    if p_expected_updated_at is not null then raise exception 'CLOUD_CONFLICT: Cloud record no longer exists. Reload before saving.'; end if;
    insert into public.etl_cloud_data(user_id,payload,updated_at) values(auth.uid(),p_payload,now()) returning updated_at into v_updated;
  end if;
  update public.etl_devices set last_seen_at=now() where user_id=auth.uid() and device_id=p_device_id;
  return v_updated;
end; $$;

create or replace function public.etl_list_devices(p_actor_device_id text)
returns table(device_id text,device_name text,platform text,status text,created_at timestamptz,last_seen_at timestamptz,approved_at timestamptz,revoked_at timestamptz)
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists(select 1 from public.etl_devices where user_id=auth.uid() and device_id=p_actor_device_id and status='approved') then raise exception 'Current device is not approved'; end if;
  return query select d.device_id,d.device_name,d.platform,d.status,d.created_at,d.last_seen_at,d.approved_at,d.revoked_at
    from public.etl_devices d where d.user_id=auth.uid() order by d.created_at;
end; $$;

create or replace function public.etl_approve_device(p_actor_device_id text,p_target_device_id text)
returns boolean language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists(select 1 from public.etl_devices where user_id=auth.uid() and device_id=p_actor_device_id and status='approved') then raise exception 'Current device is not approved'; end if;
  update public.etl_devices set status='approved',approved_at=now(),revoked_at=null
   where user_id=auth.uid() and device_id=p_target_device_id and status='pending';
  return found;
end; $$;

create or replace function public.etl_revoke_device(p_actor_device_id text,p_target_device_id text)
returns boolean language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists(select 1 from public.etl_devices where user_id=auth.uid() and device_id=p_actor_device_id and status='approved') then raise exception 'Current device is not approved'; end if;
  if p_actor_device_id=p_target_device_id then raise exception 'Use sign out to leave this device'; end if;
  update public.etl_devices set status='revoked',revoked_at=now() where user_id=auth.uid() and device_id=p_target_device_id and status='approved';
  return found;
end; $$;

revoke all on function public.etl_register_device(text,text,text) from public, anon;
revoke all on function public.etl_get_cloud_data(text) from public, anon;
revoke all on function public.etl_save_cloud_data(text,jsonb,timestamptz) from public, anon;
revoke all on function public.etl_list_devices(text) from public, anon;
revoke all on function public.etl_approve_device(text,text) from public, anon;
revoke all on function public.etl_revoke_device(text,text) from public, anon;

grant execute on function public.etl_register_device(text,text,text) to authenticated;
grant execute on function public.etl_get_cloud_data(text) to authenticated;
grant execute on function public.etl_save_cloud_data(text,jsonb,timestamptz) to authenticated;
grant execute on function public.etl_list_devices(text) to authenticated;
grant execute on function public.etl_approve_device(text,text) to authenticated;
grant execute on function public.etl_revoke_device(text,text) to authenticated;
