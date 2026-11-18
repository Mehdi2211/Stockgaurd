-- =====================================================================
-- Migration 005 : REVERT de la migration 004 (remboursements de credit)
-- =====================================================================
-- NE PAS executer automatiquement : a relire puis lancer manuellement.
-- Retire UNIQUEMENT les objets ajoutes par 004_credits_repayments.sql :
--   1. les 3 triggers append-only sur credits ;
--   2. la RLS + REVOKE/GRANT sur credits ;
--   3. l'index credits_shop_created_idx.
-- AUCUNE ligne n'est supprimee ni modifiee. Les migrations 001-003 et
-- leurs objets ne sont pas touches.
-- =====================================================================

BEGIN;

-- 1. Triggers append-only ajoutes par 004
DROP TRIGGER IF EXISTS credits_no_update   ON credits;
DROP TRIGGER IF EXISTS credits_no_delete   ON credits;
DROP TRIGGER IF EXISTS credits_no_truncate ON credits;

-- 2. RLS : desactivation + restauration des droits par defaut
ALTER TABLE credits DISABLE ROW LEVEL SECURITY;
GRANT ALL ON credits TO PUBLIC;

-- 3. Index ajoute par 004
DROP INDEX IF EXISTS credits_shop_created_idx;

COMMIT;

-- Verification (manuel) :
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'credits'::regclass;
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'credits';
--   SELECT indexname FROM pg_indexes WHERE tablename = 'credits';
