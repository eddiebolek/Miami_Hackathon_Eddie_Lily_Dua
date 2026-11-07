-- Spreadsheet checker: per-flag note + flag payload, link findings to an upload, sign-off per upload.
-- Existing grants and the team_access RLS policy already cover new columns. Run once, after the baseline.
alter table public.rhb_datasets add column signoff jsonb;
alter table public.rhb_findings
 add column note text check(char_length(note)<=1000),
 add column flag jsonb,
 add column dataset_id uuid,
 add constraint rhb_findings_dataset_fk foreign key(team_id,dataset_id) references public.rhb_datasets(team_id,id) on delete cascade;
create index on public.rhb_findings(dataset_id);
