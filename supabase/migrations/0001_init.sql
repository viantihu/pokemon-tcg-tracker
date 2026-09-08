-- 0001_init — baseline extensions.
-- Migrations are FORWARD-ONLY and ordered. Never edit a merged migration; add a
-- new one (docs/devops-strategy.md §6). The domain schema (CatalogCard, Copy,
-- Binder, EvolutionLine, ... per docs/system-design.md §4) lands in later,
-- reviewed migrations once the pipeline is proven green.

-- gen_random_uuid() for app-generated stable copy ids.
create extension if not exists pgcrypto;
