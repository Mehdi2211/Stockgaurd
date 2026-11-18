-- =====================================================================
-- Migration 003 — Réinitialisation de caisse (plusieurs INITIALIZATION)
--
-- Avant : un seul INITIALIZATION par boutique (index unique partiel).
-- Après : la réinitialisation crée une NOUVELLE ligne INITIALIZATION
-- (l'ancienne reste, append-only) ; le calcul part de la PLUS RÉCENTE.
-- =====================================================================

-- 1. Supprimer la contrainte d'unicité (une seule initialisation).
DROP INDEX IF EXISTS cash_movements_init_uq;

-- 2. Index pour retrouver rapidement la DERNIÈRE initialisation d'une
--    boutique (ORDER BY created_at DESC LIMIT 1).
CREATE INDEX IF NOT EXISTS cash_movements_init_shop_idx
  ON cash_movements (shop_id, created_at)
  WHERE type = 'INITIALIZATION';
