-- =====================================================================
-- StockGuard - Migration 001 : Suivi de caisse (Cash Register Monitoring)
-- =====================================================================
-- Module réservé au propriétaire (OWNER) pour comparer la caisse
-- théorique (calculée par l'application) à la caisse physique comptée.
--
-- CONVENTION DE SIGNE (montants en millimes, bigint) :
--   cash_movements.amount est TOUJOURS signé :
--     INITIALIZATION >= 0   (fond de caisse de départ)
--     DEPOSIT        >  0   (entrée d'argent)
--     WITHDRAWAL     <  0   (sortie d'argent, stockée en négatif)
--     CASH_REFUND    <  0   (remboursement en espèces, stocké en négatif)
--     ADJUSTMENT     <> 0   (correction signée, positive ou négative)
--   cash_verifications.difference = actual_balance - theoretical_balance
--     > 0 : excédent | = 0 : correct | < 0 : manque
--
-- Les ventes en espèces et les remboursements de crédit NE SONT PAS
-- copiés dans cash_movements : ils sont dérivés des tables
-- `sales` (customer_id IS NULL) et `credits` (amount < 0).
-- =====================================================================

BEGIN;

-- 0. Type énuméré
CREATE TYPE cash_movement_type AS ENUM (
  'INITIALIZATION',
  'DEPOSIT',
  'WITHDRAWAL',
  'CASH_REFUND',
  'ADJUSTMENT'
);

-- 1. Fonction générique anti-modification (append-only)
--    Réutilisable par toute table financière historique.
CREATE OR REPLACE FUNCTION forbid_modify() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % : historique financier en lecture seule (append-only).', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- 2. Vérification : admin_id doit être un OWNER actif de la même boutique
CREATE OR REPLACE FUNCTION cash_register_check_admin() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app_users
    WHERE id = NEW.admin_id
      AND shop_id = NEW.shop_id
      AND role = 'OWNER'
      AND is_active
  ) THEN
    RAISE EXCEPTION 'admin_id doit référencer un propriétaire actif de la boutique.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Mouvements de caisse (append-only)
CREATE TABLE cash_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id),
  type        cash_movement_type NOT NULL,
  amount      bigint NOT NULL,
  description text,
  sale_id     uuid REFERENCES sales(id),
  admin_id    uuid NOT NULL REFERENCES app_users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cm_amount_sign_chk CHECK (
       (type = 'INITIALIZATION' AND amount >= 0)
    OR (type = 'DEPOSIT'        AND amount >  0)
    OR (type = 'WITHDRAWAL'     AND amount <  0)
    OR (type = 'CASH_REFUND'    AND amount <  0)
    OR (type = 'ADJUSTMENT'     AND amount <> 0)
  ),
  -- description obligatoire sauf pour INITIALIZATION
  CONSTRAINT cm_description_chk CHECK (
       type = 'INITIALIZATION'
    OR length(btrim(coalesce(description, ''))) > 0
  ),
  -- sale_id autorisé UNIQUEMENT pour CASH_REFUND
  CONSTRAINT cm_sale_link_chk CHECK (
       (type = 'CASH_REFUND') = (sale_id IS NOT NULL)
  )
);

-- Une seule initialisation par boutique
CREATE UNIQUE INDEX cash_movements_init_uq
  ON cash_movements (shop_id) WHERE type = 'INITIALIZATION';
CREATE INDEX cash_movements_shop_created_idx
  ON cash_movements (shop_id, created_at);
CREATE INDEX cash_movements_sale_idx
  ON cash_movements (sale_id) WHERE sale_id IS NOT NULL;

CREATE TRIGGER cash_movements_admin_chk
  BEFORE INSERT ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION cash_register_check_admin();

CREATE TRIGGER cash_movements_no_update
  BEFORE UPDATE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_modify();

CREATE TRIGGER cash_movements_no_delete
  BEFORE DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_modify();

CREATE TRIGGER cash_movements_no_truncate
  BEFORE TRUNCATE ON cash_movements
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modify();

-- 4. Vérifications de caisse (append-only, instantanés)
CREATE TABLE cash_verifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid NOT NULL REFERENCES shops(id),
  theoretical_balance bigint NOT NULL,
  actual_balance      bigint NOT NULL CHECK (actual_balance >= 0),
  difference          bigint GENERATED ALWAYS AS (actual_balance - theoretical_balance) STORED,
  status              text GENERATED ALWAYS AS (
    CASE
      WHEN actual_balance = theoretical_balance THEN 'CORRECT'
      WHEN actual_balance < theoretical_balance THEN 'SHORTAGE'
      ELSE 'SURPLUS'
    END
  ) STORED,
  admin_id            uuid NOT NULL REFERENCES app_users(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cash_verifications_shop_created_idx
  ON cash_verifications (shop_id, created_at);

CREATE TRIGGER cash_verifications_admin_chk
  BEFORE INSERT ON cash_verifications
  FOR EACH ROW EXECUTE FUNCTION cash_register_check_admin();

CREATE TRIGGER cash_verifications_no_update
  BEFORE UPDATE ON cash_verifications
  FOR EACH ROW EXECUTE FUNCTION forbid_modify();

CREATE TRIGGER cash_verifications_no_delete
  BEFORE DELETE ON cash_verifications
  FOR EACH ROW EXECUTE FUNCTION forbid_modify();

CREATE TRIGGER cash_verifications_no_truncate
  BEFORE TRUNCATE ON cash_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modify();

-- 5. Row Level Security : aucune policy => accès refusé via l'API
--    Supabase (anon / authenticated). Le backend se connecte avec un
--    rôle privilégié (postgres / service_role) qui contourne la RLS.
ALTER TABLE cash_movements     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_verifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON cash_movements     FROM anon, authenticated;
REVOKE ALL ON cash_verifications FROM anon, authenticated;
REVOKE ALL ON cash_movements     FROM PUBLIC;
REVOKE ALL ON cash_verifications FROM PUBLIC;

GRANT ALL ON cash_movements     TO service_role;
GRANT ALL ON cash_verifications TO service_role;

COMMIT;
