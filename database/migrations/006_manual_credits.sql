-- =====================================================================
-- Migration 006 : dettes manuelles dans credits
-- =====================================================================
-- La gestion des credits (interface "Gestion des credits") permet au
-- proprietaire d'ajouter une dette SANS vente (sale_id NULL, amount > 0)
-- et d'enregistrer un remboursement (sale_id NULL, amount < 0).
-- L'ancien CHECK n'autorisait amount > 0 que si sale_id NOT NULL.
-- Nouveau CHECK :
--   - vente a credit        : sale_id NOT NULL, reverses_id NULL, amount > 0
--   - dette manuelle        : sale_id NULL,     reverses_id NULL, amount > 0
--   - remboursement         : sale_id NULL,     reverses_id NULL, amount < 0
--   - contre-passation      : sale_id NULL,     reverses_id NOT NULL, amount <> 0
-- Aucune ligne existante n'est modifiee.
-- =====================================================================

BEGIN;

ALTER TABLE credits DROP CONSTRAINT IF EXISTS credits_amount_chk;
ALTER TABLE credits ADD CONSTRAINT credits_amount_chk CHECK (
     (sale_id IS NOT NULL AND reverses_id IS NULL     AND amount > 0)
  OR (sale_id IS NULL     AND reverses_id IS NULL     AND amount > 0)
  OR (sale_id IS NULL     AND reverses_id IS NULL     AND amount < 0)
  OR (sale_id IS NULL     AND reverses_id IS NOT NULL AND amount <> 0)
);

COMMIT;
