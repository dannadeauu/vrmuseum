-- =====================================================================
-- Virtual Museum: Supabase setup
-- Paste this whole file into Supabase -> SQL Editor -> New query -> Run.
-- It is safe to run again (for example after adding another admin user).
--
-- What it creates:
--   museum_items   one row per exhibit (painting, sign, sculpture, bench...)
--   museum_meta    small settings (whether the layout has been published)
--   museum_admins  which logged-in users may change the museum
--   museum-files   a public storage bucket for uploaded images, PDFs and models
--   museum_board_strokes  drawings on whiteboards (one row per pen stroke)
-- Everyone can VIEW. Only users listed in museum_admins can CHANGE anything,
-- except whiteboards: every visitor may draw on them and clear them.
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.museum_items (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.museum_meta (
  key    text primary key,
  value  jsonb
);

create table if not exists public.museum_admins (
  user_id  uuid primary key references auth.users (id) on delete cascade
);

-- ---------- who is an admin ----------
create or replace function public.is_museum_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.museum_admins where user_id = auth.uid());
$$;

-- Every user that exists right now becomes an admin. Create your admin login
-- (Authentication -> Users -> Add user) BEFORE running this file, or run it again after.
-- Users created later are NOT admins unless you run this again.
insert into public.museum_admins (user_id)
select id from auth.users
on conflict do nothing;

-- ---------- row level security ----------
alter table public.museum_items  enable row level security;
alter table public.museum_meta   enable row level security;
alter table public.museum_admins enable row level security;

drop policy if exists "items: anyone can view"   on public.museum_items;
drop policy if exists "items: admins can add"    on public.museum_items;
drop policy if exists "items: admins can change" on public.museum_items;
drop policy if exists "items: admins can remove" on public.museum_items;
create policy "items: anyone can view"   on public.museum_items for select using (true);
create policy "items: admins can add"    on public.museum_items for insert to authenticated with check (public.is_museum_admin());
create policy "items: admins can change" on public.museum_items for update to authenticated using (public.is_museum_admin()) with check (public.is_museum_admin());
create policy "items: admins can remove" on public.museum_items for delete to authenticated using (public.is_museum_admin());

drop policy if exists "meta: anyone can view"   on public.museum_meta;
drop policy if exists "meta: admins can add"    on public.museum_meta;
drop policy if exists "meta: admins can change" on public.museum_meta;
drop policy if exists "meta: admins can remove" on public.museum_meta;
create policy "meta: anyone can view"   on public.museum_meta for select using (true);
create policy "meta: admins can add"    on public.museum_meta for insert to authenticated with check (public.is_museum_admin());
create policy "meta: admins can change" on public.museum_meta for update to authenticated using (public.is_museum_admin()) with check (public.is_museum_admin());
create policy "meta: admins can remove" on public.museum_meta for delete to authenticated using (public.is_museum_admin());

drop policy if exists "admins: see own row" on public.museum_admins;
create policy "admins: see own row" on public.museum_admins for select to authenticated using (user_id = auth.uid());

grant select on public.museum_items, public.museum_meta to anon, authenticated;
grant insert, update, delete on public.museum_items, public.museum_meta to authenticated;
grant select on public.museum_admins to authenticated;
grant execute on function public.is_museum_admin() to anon, authenticated;

-- keep updated_at current
create or replace function public.museum_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists museum_items_touch on public.museum_items;
create trigger museum_items_touch before update on public.museum_items
for each row execute function public.museum_touch();

-- ---------- live updates (Supabase Realtime) ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'museum_items'
  ) then
    alter publication supabase_realtime add table public.museum_items;
  end if;
end $$;

-- ---------- whiteboards: anyone can draw and clear ----------
create table if not exists public.museum_board_strokes (
  id          uuid primary key default gen_random_uuid(),
  board_id    text not null,
  stroke      jsonb not null check (octet_length(stroke::text) < 24000), -- one pen stroke
  created_at  timestamptz not null default now()
);
create index if not exists museum_board_strokes_board on public.museum_board_strokes (board_id, created_at);
alter table public.museum_board_strokes enable row level security;
drop policy if exists "boards: anyone can view"  on public.museum_board_strokes;
drop policy if exists "boards: anyone can draw"  on public.museum_board_strokes;
drop policy if exists "boards: anyone can clear" on public.museum_board_strokes;
create policy "boards: anyone can view"  on public.museum_board_strokes for select using (true);
create policy "boards: anyone can draw"  on public.museum_board_strokes for insert to anon, authenticated with check (true);
create policy "boards: anyone can clear" on public.museum_board_strokes for delete to anon, authenticated using (true);
grant select, insert, delete on public.museum_board_strokes to anon, authenticated;

-- ---------- file storage ----------
insert into storage.buckets (id, name, public)
values ('museum-files', 'museum-files', true)
on conflict (id) do update set public = true;

drop policy if exists "museum files: anyone can view"   on storage.objects;
drop policy if exists "museum files: admins can upload" on storage.objects;
drop policy if exists "museum files: admins can change" on storage.objects;
drop policy if exists "museum files: admins can remove" on storage.objects;
create policy "museum files: anyone can view"   on storage.objects for select using (bucket_id = 'museum-files');
create policy "museum files: admins can upload" on storage.objects for insert to authenticated with check (bucket_id = 'museum-files' and public.is_museum_admin());
create policy "museum files: admins can change" on storage.objects for update to authenticated using (bucket_id = 'museum-files' and public.is_museum_admin());
create policy "museum files: admins can remove" on storage.objects for delete to authenticated using (bucket_id = 'museum-files' and public.is_museum_admin());

-- Done. Check: Table Editor should now show museum_items, museum_meta and museum_admins,
-- and museum_admins should contain one row per admin login.
