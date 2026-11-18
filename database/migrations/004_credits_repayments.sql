-- =====================================================================
-- Migration 004 : remboursements de crédit (credits) — append-only + RLS
-- =====================================================================
-- La table credits existait déjà (ventes à crédit + remboursements lus
-- par computeExpected) mais sans protection append-only ni RLS.
-- Aucune donnée existante n'est modifiée.
-- =====================================================================

-- 1. Append-only : UPDATE / DELETE / TRUNCATE interdits (comme
--    cash_movements / cash_verifications). forbid_modify() existe déjà.
DROP TRIGGER IF EXISTS credits_no_update   ON credits;
CREATE TRIGGER credits_no_update
  BEFORE UPDATE ON credits
  FOR EACH ROW EXECUTE FUNCTION forbid_modify();
DROP TRIGGER IF EXISTS credits_no_delete   ON credits;
CREATE TRIGGER credits_no_delete
  BEFORE DELETE ON credits
  FOR EACH ROW EXECUTE FUNCTION forbid_modify();
DROP TRIGGER IF EXISTS credits_no_truncate ON credits;
CREATE TRIGGER credits_no_truncate
  BEFORE TRUNCATE ON credits
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modify();

-- 2. RLS activée, AUCUNE politique : accès uniquement via le backend
--    (rôle privilégié / service_role), comme les tables caisse.
ALTER TABLE credits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON credits FROM anon, authenticated;
REVOKE ALL ON credits FROM PUBLIC;
GRANT ALL ON credits TO service_role;

-- 3. Index pour computeExpected : fenêtre [initialisation, T] par boutique.
CREATE INDEX IF NOT EXISTS credits_shop_created_idx ON credits (shop_id, created_at);
