-- Схема для онлайн-режима «Денежного потока».
-- Выполните в Supabase: Dashboard → SQL Editor → вставить и запустить.

create table if not exists cf_rooms (
  code text primary key,            -- номер комнаты (4 цифры)
  state jsonb not null default '{}'::jsonb,  -- полное состояние игры
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists cf_actions (
  id bigint generated always as identity primary key,
  code text not null,
  player_id int,                    -- кто шлёт (-1 = гость в лобби)
  action jsonb not null,            -- {type:'join'|'roll'|'loan'|...} или {seq, value} — ответ на решение
  created_at timestamptz not null default now()
);

-- Для простой игры политики максимально открыты (анонимный ключ Supabase и так публичен).
-- Это осознанный компромисс: комната защищена только номером.
alter table cf_rooms enable row level security;
alter table cf_actions enable row level security;

drop policy if exists "rooms anon all" on cf_rooms;
create policy "rooms anon all" on cf_rooms for all to anon using (true) with check (true);

drop policy if exists "actions anon all" on cf_actions;
create policy "actions anon all" on cf_actions for all to anon using (true) with check (true);
