-- 0039_catalog_species_gaps — a printing TCGdex left without its species or what it evolves from takes them from its
-- other printings, when they all agree.
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0038 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- WHY. A new set lands in TCGdex before its data is complete: the 30th set's Cherrim (30th-007) came back with no
-- `dexId` and no `evolveFrom`, so `buildChain` found no Cherubi behind it and the app called it a species with no
-- evolutions ("Cherrim has no evolutions, so this line would hold just this one card"). Every other English Cherrim
-- says 421 and "Cherubi". Measured on Testing (2026-10-23): 155 of the 30th set's 158 cards had no `dex_id` and 33 of
-- its Stage 1/2 cards no `evolve_from`; across the catalog, ~370 rows' species and ~880 rows' prior stage are filled
-- by this rule, and the many Japanese sets with the same gaps are covered by the same rule in their own language.
--
-- THE RULE. A mirror row (`source = 'tcgdex'`) with an empty `dex_id`, or a non-Basic row with a NULL
-- `evolve_from`, takes the value from the other mirror printings of the SAME card: same language, same name (trimmed,
-- lower-cased, as `buildChain` compares names) and same stage. Only when every one of them that has a value has the
-- SAME value: a disagreement (TCGdex has a Lapras printed with Magikarp's dex id) fills nothing. A name with no
-- other printing (a brand-new "Fuecoco ex") fills nothing. A value TCGdex sends is never overwritten, and a
-- stand-in (`source = 'user'`) is neither filled nor used to fill: it is one account's own row.
--
--   fill_catalog_species_gaps(p_set_id)   NEW: applies the rule to one set's rows (the mirror calls it after each
--                                         set it upserts, since an upsert writes TCGdex's gaps back), or to every row
--                                         when NULL. Returns how many values it filled. Idempotent.
--
-- The migration runs it once over the whole catalog.
--
-- SECURITY: `security invoker`, `set search_path = public, pg_temp`, no dynamic SQL. catalog_card is read-only to the
-- app under RLS, so only the service role (the mirror) is granted it.

create or replace function fill_catalog_species_gaps(p_set_id text default null)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  dex_filled integer;
  from_filled integer;
begin
  with donors as (
    select locale, lower(trim(name)) as n, stage, min(dex_id::text)::integer[] as dex_id
    from catalog_card
    where source = 'tcgdex' and stage is not null and cardinality(dex_id) > 0
    group by locale, lower(trim(name)), stage
    having count(distinct dex_id) = 1
  )
  update catalog_card c
     set dex_id = d.dex_id
    from donors d
   where c.source = 'tcgdex'
     and (p_set_id is null or c.set_id = p_set_id)
     and cardinality(c.dex_id) = 0
     and d.locale = c.locale
     and d.n = lower(trim(c.name))
     and d.stage = c.stage;
  get diagnostics dex_filled = row_count;

  with donors as (
    select locale, lower(trim(name)) as n, stage, min(evolve_from) as evolve_from
    from catalog_card
    where source = 'tcgdex' and stage is not null and evolve_from is not null
    group by locale, lower(trim(name)), stage
    having count(distinct evolve_from) = 1
  )
  update catalog_card c
     set evolve_from = d.evolve_from
    from donors d
   where c.source = 'tcgdex'
     and (p_set_id is null or c.set_id = p_set_id)
     and c.evolve_from is null
     and c.stage <> 'Basic'
     and d.locale = c.locale
     and d.n = lower(trim(c.name))
     and d.stage = c.stage;
  get diagnostics from_filled = row_count;

  return dex_filled + from_filled;
end;
$$;

revoke all on function fill_catalog_species_gaps(text) from public;
grant execute on function fill_catalog_species_gaps(text) to service_role;

select fill_catalog_species_gaps(null);
