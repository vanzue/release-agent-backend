alter table jobs
  drop constraint if exists jobs_type_check;

alter table jobs
  add constraint jobs_type_check
  check (type in ('parse-changes','generate-notes','analyze-hotspots','generate-testplan','generate-testchecklists'));
