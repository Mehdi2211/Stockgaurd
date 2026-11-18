-- =====================================================================
-- StockGuard - MVP schema for PostgreSQL / Supabase
-- =====================================================================

-- 0. ENUM types (idempotent : ignorés si déjà présents)
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('OWNER', 'CASHIER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE movement_type AS ENUM ('INITIAL', 'RESTOCK', 'SALE', 'ADJUSTMENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE customer_status AS ENUM ('PENDING', 'VALIDATED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 1. Tables
CREATE TABLE IF NOT EXISTS shops (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{6,12}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid NOT NULL REFERENCES shops(id),
  name                text NOT NULL CHECK (length(btrim(name)) > 0),
  role                user_role NOT NULL,
  email               text,
  password_hash       text,
  pin_hash            text,
  is_active           boolean NOT NULL DEFAULT true,
  failed_pin_attempts smallint NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_users_credentials_chk CHECK (
       (role = 'OWNER'   AND email IS NOT NULL AND password_hash IS NOT NULL)
    OR (role = 'CASHIER' AND pin_hash IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS app_users_shop_email_uq
  ON app_users (shop_id, lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id),
  barcode        text,
  name           text NOT NULL CHECK (length(btrim(name)) > 0),
  price          bigint NOT NULL CHECK (price >= 0),
  current_stock  numeric(12,3) NOT NULL DEFAULT 0,
  min_stock      numeric(12,3) NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_barcode_len_chk CHECK (barcode IS NULL OR length(barcode) BETWEEN 4 AND 32)
);
CREATE UNIQUE INDEX IF NOT EXISTS products_shop_barcode_uq ON products (shop_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_shop_name_idx ON products (shop_id, lower(name));

CREATE TABLE IF NOT EXISTS customers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid NOT NULL REFERENCES shops(id),
  first_name          text NOT NULL CHECK (length(btrim(first_name)) > 0),
  family_name         text NOT NULL CHECK (length(btrim(family_name)) > 0),
  phone               text NOT NULL CHECK (phone ~ '^[0-9]{8}$'),
  cin                 text NOT NULL CHECK (cin ~ '^[0-9]{8}$'),
  pin_hash            text NOT NULL,
  status              customer_status NOT NULL DEFAULT 'PENDING',
  created_by          uuid NOT NULL REFERENCES app_users(id),
  validated_by        uuid REFERENCES app_users(id),
  validated_at        timestamptz,
  failed_pin_attempts smallint NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_cin_uq   UNIQUE (shop_id, cin),
  CONSTRAINT customers_phone_uq UNIQUE (shop_id, phone),
  CONSTRAINT customers_validation_chk CHECK (
       (status = 'PENDING'   AND validated_by IS NULL     AND validated_at IS NULL)
    OR (status = 'VALIDATED' AND validated_by IS NOT NULL AND validated_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS customers_search_idx ON customers (shop_id, lower(family_name), lower(first_name));

-- Fonction partagée : interdit UPDATE/DELETE/TRUNCATE sur les tables
-- financières append-only (credits, cash_movements, cash_verifications).
CREATE OR REPLACE FUNCTION forbid_modify() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % : historique financier en lecture seule (append-only).', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS sales (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid NOT NULL REFERENCES shops(id),
  number          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  client_sale_id  uuid NOT NULL,
  cashier_id      uuid NOT NULL REFERENCES app_users(id),
  customer_id     uuid REFERENCES customers(id),
  total           bigint NOT NULL CHECK (total > 0),
  device_id       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_idempotency_uq UNIQUE (shop_id, client_sale_id)
);
CREATE INDEX IF NOT EXISTS sales_shop_created_idx ON sales (shop_id, created_at);
CREATE INDEX IF NOT EXISTS sales_cashier_idx      ON sales (cashier_id, created_at);
CREATE INDEX IF NOT EXISTS sales_customer_idx     ON sales (customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sale_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id     uuid NOT NULL REFERENCES sales(id),
  product_id  uuid NOT NULL REFERENCES products(id),
  quantity    numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price  bigint NOT NULL CHECK (unit_price >= 0),
  line_total  bigint GENERATED ALWAYS AS (round(quantity * unit_price)::bigint) STORED
);
CREATE INDEX IF NOT EXISTS sale_lines_sale_idx    ON sale_lines (sale_id);
CREATE INDEX IF NOT EXISTS sale_lines_product_idx ON sale_lines (product_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id),
  product_id   uuid NOT NULL REFERENCES products(id),
  type         movement_type NOT NULL,
  quantity     numeric(12,3) NOT NULL,
  reason       text,
  sale_id      uuid REFERENCES sales(id),
  reverses_id  uuid REFERENCES stock_movements(id),
  recorded_by  uuid NOT NULL REFERENCES app_users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sm_quantity_sign_chk CHECK (
       (type IN ('INITIAL', 'RESTOCK') AND quantity > 0)
    OR (type = 'SALE'                  AND quantity < 0)
    OR (type = 'ADJUSTMENT'            AND quantity <> 0)
  ),
  CONSTRAINT sm_sale_link_chk     CHECK ((type = 'SALE') = (sale_id IS NOT NULL)),
  CONSTRAINT sm_reversal_chk      CHECK (reverses_id IS NULL OR type = 'ADJUSTMENT'),
  CONSTRAINT sm_adjust_reason_chk CHECK (type <> 'ADJUSTMENT' OR length(btrim(coalesce(reason, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS stock_movements_product_idx ON stock_movements (product_id, created_at);
CREATE INDEX IF NOT EXISTS stock_movements_sale_idx    ON stock_movements (sale_id) WHERE sale_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_reverses_uq
  ON stock_movements (reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS credits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id),
  customer_id  uuid NOT NULL REFERENCES customers(id),
  sale_id      uuid REFERENCES sales(id),
  reverses_id  uuid REFERENCES credits(id),
  amount       bigint NOT NULL,
  note         text,
  recorded_by  uuid NOT NULL REFERENCES app_users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credits_amount_chk CHECK (
       (sale_id IS NOT NULL AND reverses_id IS NULL     AND amount > 0)
    OR (sale_id IS NULL     AND reverses_id IS NULL     AND amount < 0)
    OR (sale_id IS NULL     AND reverses_id IS NOT NULL AND amount <> 0)
  ),
  CONSTRAINT credits_reversal_note_chk
    CHECK (reverses_id IS NULL OR length(btrim(coalesce(note, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS credits_customer_idx ON credits (customer_id, created_at);
CREATE INDEX IF NOT EXISTS credits_shop_created_idx ON credits (shop_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS credits_sale_uq     ON credits (sale_id)     WHERE sale_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS credits_reverses_uq ON credits (reverses_id) WHERE reverses_id IS NOT NULL;

-- Append-only : les crédits (ventes à crédit, remboursements) sont un
-- historique financier en lecture seule. Une erreur se corrige par une
-- écriture inverse (reverses_id), jamais par UPDATE/DELETE.
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

ALTER TABLE credits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON credits FROM anon, authenticated;
REVOKE ALL ON credits FROM PUBLIC;
GRANT ALL ON credits TO service_role;

CREATE TABLE IF NOT EXISTS audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id      uuid NOT NULL REFERENCES shops(id),
  actor_id     uuid REFERENCES app_users(id),
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  before_data  jsonb,
  after_data   jsonb,
  device_id    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx  ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (shop_id, created_at);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx   ON audit_log (actor_id, created_at);

-- =====================================================================
-- 6. Suivi de caisse (Cash Register Monitoring) - module OWNER
-- =====================================================================
-- CONVENTION DE SIGNE (montants en millimes, bigint) :
--   cash_movements.amount est TOUJOURS signé :
--     INITIALIZATION >= 0 | DEPOSIT > 0 | WITHDRAWAL < 0
--     CASH_REFUND < 0 | ADJUSTMENT <> 0
--   cash_verifications.difference = actual_balance - theoretical_balance
-- Les ventes en espèces et remboursements de crédit sont DÉRIVÉS des
-- tables sales / credits, jamais copiés dans cash_movements.

DO $$ BEGIN
  CREATE TYPE cash_movement_type AS ENUM (
    'INITIALIZATION', 'DEPOSIT', 'WITHDRAWAL', 'CASH_REFUND', 'ADJUSTMENT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION cash_register_check_admin() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app_users
    WHERE id = NEW.admin_id AND shop_id = NEW.shop_id
      AND role = 'OWNER' AND is_active
  ) THEN
    RAISE EXCEPTION 'admin_id doit référencer un propriétaire actif de la boutique.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS cash_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id),
  type        cash_movement_type NOT NULL,
  amount      bigint NOT NULL,
  description text,
  sale_id     uuid REFERENCES sales(id),
  admin_id    uuid NOT NULL REFERENCES app_users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Date/heure d'initialisation choisie par le proprietaire (point de depart des calculs).
  effective_at timestamptz,
  CONSTRAINT cm_amount_sign_chk CHECK (
       (type = 'INITIALIZATION' AND amount >= 0)
    OR (type = 'DEPOSIT'        AND amount >  0)
    OR (type = 'WITHDRAWAL'     AND amount <  0)
    OR (type = 'CASH_REFUND'    AND amount <  0)
    OR (type = 'ADJUSTMENT'     AND amount <> 0)
  ),
  CONSTRAINT cm_description_chk CHECK (
       type = 'INITIALIZATION'
    OR length(btrim(coalesce(description, ''))) > 0
  ),
  CONSTRAINT cm_sale_link_chk CHECK (
       (type = 'CASH_REFUND') = (sale_id IS NOT NULL)
  )
);
-- Migration 003 : plusieurs INITIALIZATION par boutique (réinitialisation).
-- Le calcul part de la PLUS RÉCENTE (ORDER BY created_at DESC LIMIT 1).
CREATE INDEX IF NOT EXISTS cash_movements_init_shop_idx
  ON cash_movements (shop_id, created_at)
  WHERE type = 'INITIALIZATION';
CREATE INDEX IF NOT EXISTS cash_movements_shop_created_idx
  ON cash_movements (shop_id, created_at);
CREATE INDEX IF NOT EXISTS cash_movements_sale_idx
  ON cash_movements (sale_id) WHERE sale_id IS NOT NULL;

-- CHECKs migration 002 (NOT VALID : tolerent les lignes existantes,
-- append-only). COALESCE(effective_at, created_at) = date d'initialisation.
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

DROP TRIGGER IF EXISTS cash_movements_admin_chk ON cash_movements;
CREATE TRIGGER cash_movements_admin_chk
  BEFORE INSERT ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION cash_register_check_admin();
DROP TRIGGER IF EXISTS cash_movements_no_update ON cash_movements;
CREATE TRIGGER cash_movements_no_update
  BEFORE UPDATE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_modify();
DROP TRIGGER IF EXISTS cash_movements_no_delete ON cash_movements;
CREATE TRIGGER cash_movements_no_delete
  BEFORE DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_modify();
DROP TRIGGER IF EXISTS cash_movements_no_truncate ON cash_movements;
CREATE TRIGGER cash_movements_no_truncate
  BEFORE TRUNCATE ON cash_movements
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modify();

CREATE TABLE IF NOT EXISTS cash_verifications (
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
CREATE INDEX IF NOT EXISTS cash_verifications_shop_created_idx
  ON cash_verifications (shop_id, created_at);

DROP TRIGGER IF EXISTS cash_verifications_admin_chk ON cash_verifications;
CREATE TRIGGER cash_verifications_admin_chk
  BEFORE INSERT ON cash_verifications
  FOR EACH ROW EXECUTE FUNCTION cash_register_check_admin();
DROP TRIGGER IF EXISTS cash_verifications_no_update ON cash_verifications;
CREATE TRIGGER cash_verifications_no_update
  BEFORE UPDATE ON cash_verifications
  FOR EACH ROW EXECUTE FUNCTION forbid_modify();
DROP TRIGGER IF EXISTS cash_verifications_no_delete ON cash_verifications;
CREATE TRIGGER cash_verifications_no_delete
  BEFORE DELETE ON cash_verifications
  FOR EACH ROW EXECUTE FUNCTION forbid_modify();
DROP TRIGGER IF EXISTS cash_verifications_no_truncate ON cash_verifications;
CREATE TRIGGER cash_verifications_no_truncate
  BEFORE TRUNCATE ON cash_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modify();

ALTER TABLE cash_movements     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cash_movements     FROM anon, authenticated;
REVOKE ALL ON cash_verifications FROM anon, authenticated;
REVOKE ALL ON cash_movements     FROM PUBLIC;
REVOKE ALL ON cash_verifications FROM PUBLIC;
GRANT ALL ON cash_movements     TO service_role;
GRANT ALL ON cash_verifications TO service_role;
