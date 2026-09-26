-- 0027_stand_in_language — a stand-in records the LANGUAGE its card is printed in (UIL-108; Karvi: offer
-- every language TCGdex publishes, pre-filled from the Dex row, shown wherever the stand-in appears, and
-- used so that when TCGdex adds the real card, the same-language printing is the one it is swapped for).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0026 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- WHERE THE LANGUAGE LIVES: in the stand-in's id, `user:<language>:<uuid>` (the Senior BA's ruling). Every
-- screen already carries a card's id, so every screen can say its language without a new field threaded
-- through each view. A stand-in made before this (`user:<uuid>`) recorded no language and stays as it is.
--
-- THE ONE CONDITION: `catalog_card.locale` must not disagree with the id. A `user:ja:` stand-in whose column
-- says 'en' would be two sources of truth for one fact, and any locale-filtered read would miss it. So:
--   1. `locale` accepts every TCGdex language, but ONLY a stand-in may hold one other than 'en'/'ja': a
--      mirrored row keeps 0016's rule exactly ('en' iff its id is not `ja:`-namespaced).
--   2. A stand-in's `locale` IS its id's language segment, or 'en' when the id has none. That keeps the
--      stand-ins made before this valid (all 'en', the default they were written with).
--   3. A BEFORE trigger writes a stand-in's `locale` FROM its id, so the create path writes both from one
--      value and no caller can pass a second one. `apply_write_ops`'s `insert_catalog_stand_in` branch is
--      untouched (0026's body still runs): it never names `locale`, and the trigger fills it.
-- Plus the two guards the plan named:
--   4. The id's SHAPE: `user:`, optionally one of the languages below and a colon, then a lowercase uuid.
--   5. One stand-in per card per language: a partial unique index on (name, set name, number, language),
--      over stand-ins that RECORDED a language. lib/sync/exec.ts `findStandInTwin` asks the same question
--      first and refuses with the twin to match instead; this closes the race between two entries. A
--      stand-in with no recorded language is nobody's twin, so it is outside the index.
--
-- The language list is lib/catalog/locale.ts `TCGDEX_LANGUAGES`, verbatim;
-- tests/catalog/stand-in-language-migration.test.ts pins that the two agree.
--
-- BEFORE-READ (Testing, the Senior BA's): every existing `source = 'user'` id must already match (4) and
-- every existing stand-in's locale must be 'en', or the constraints below fail the deploy.

-- 1 + 2: the column's domain, and the rule that ties it to the id.
alter table catalog_card drop constraint catalog_card_locale_check;
alter table catalog_card add constraint catalog_card_locale_check check (
  locale in (
    'en', 'ja', 'fr', 'de', 'it', 'es', 'es-mx', 'pt', 'pt-br', 'nl', 'pl', 'ru', 'ko', 'zh-tw', 'zh-cn',
    'id', 'th'
  )
);

alter table catalog_card drop constraint catalog_card_locale_namespace;
alter table catalog_card add constraint catalog_card_locale_namespace check (
  case
    when source = 'user'
      then locale = coalesce(substring(tcgdex_id from '^user:([a-z]{2}(?:-[a-z]{2})?):'), 'en')
    else locale in ('en', 'ja') and (locale = 'en') = (tcgdex_id not like 'ja:%')
  end
);
comment on column catalog_card.locale is
  'The language this printing is in. A mirrored row: the TCGdex locale it came from (''en'' ids verbatim, every other locale namespaced ''<locale>:<id>'', UIL-047). A stand-in (source = ''user''): the language in its id, ''user:<language>:<uuid>'' (UIL-108), or ''en'' for one made before that recorded none.';

-- 3: a stand-in's locale is derived from its id, on every write that could change either.
create or replace function catalog_card_stand_in_locale()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.source = 'user' then
    new.locale := coalesce(substring(new.tcgdex_id from '^user:([a-z]{2}(?:-[a-z]{2})?):'), 'en');
  end if;
  return new;
end
$$;

create trigger catalog_card_stand_in_locale
  before insert or update of tcgdex_id, locale, source on catalog_card
  for each row execute function catalog_card_stand_in_locale();

-- 4: the id's shape. Only a `user:` id is checked here: whether a row may hold one at all is 0015's
-- `catalog_card_user_id_shape`, left to answer (and to name itself in the error) exactly as before.
alter table catalog_card add constraint catalog_card_stand_in_id_language check (
  source <> 'user'
  or tcgdex_id not like 'user:%'
  or tcgdex_id ~ (
    '^user:((en|ja|fr|de|it|es|es-mx|pt|pt-br|nl|pl|ru|ko|zh-tw|zh-cn|id|th):)?'
    || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
);

-- 5: one stand-in per card per language.
create unique index catalog_card_stand_in_twin on catalog_card (
  lower(btrim(name)),
  lower(coalesce(btrim(set_name), '')),
  lower(coalesce(btrim(local_id), '')),
  locale
)
where source = 'user' and tcgdex_id ~ '^user:[a-z]{2}(-[a-z]{2})?:';
