-- =====================================================================
-- Migration 002 - Date d'initialisation de la caisse (effective_at)
-- =====================================================================
--
-- effective_at est la date/heure choisie par le proprietaire lors de
-- l'initialisation. C'est le POINT DE DEPART de tous les calculs de la
-- caisse : ventes, remboursements et mouvements anterieurs a cette date
-- ne comptent pas.
--
-- Les CHECKs sont ajoutes NOT VALID : les lignes INITIALIZATION existantes
-- (sans effective_at) ne sont pas modifiees (append-only). Le code utilise
-- COALESCE(effective_at, created_at) comme date d'initialisation.
-- NOT VALID n'empeche pas les NOUVELLES lignes de respecter les contraintes.
-- =====================================================================

ALTER TABLE cash_movements
  ADD COLUMN IF NOT EXISTS effective_at timestamptz;

COMMENT ON COLUMN cash_movements.effective_at IS
  'Date/heure d''initialisation choisie par le proprietaire. Point de depart de tous les calculs de caisse. NULL pour tous les types sauf INITIALIZATION.';

DO $$ BEGIN
  ALTER TABLE cash_movements
    ADD CONSTRAINT cm_effective_init_chk
    CHECK ((type = 'INITIALIZATION') = (effective_at IS NOT NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE cash_movements
    ADD CONSTRAINT cm_effective_not_future_chk
    CHECK (effective_at IS NULL OR effective_at <= created_at) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE cash_movements
    ADD CONSTRAINT cm_amount_bound_chk
    CHECK (abs(amount) <= 9999999999) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE cash_verifications
    ADD CONSTRAINT cv_actual_bound_chk
    CHECK (actual_balance <= 9999999999) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE cash_movements
    ADD CONSTRAINT cm_description_len_chk
    CHECK (description IS NULL OR length(btrim(description)) BETWEEN 3 AND 200) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS cash_movements_effective_idx
  ON cash_movements (shop_id, effective_at)
  WHERE effective_at IS NOT NULL;
