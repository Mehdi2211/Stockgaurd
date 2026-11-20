-- =====================================================================
-- 007 : Authentification réelle + périmètre boutique (shop_id)
-- Idempotent : peut être relancé sans risque.
-- Ne modifie PAS les tables financières existantes (caisse, crédits).
-- =====================================================================

-- 1. Boutique : propriétaire (OWNER) rattaché.
--    Colonne nullable + FK ajoutée après coup (app_users doit exister).
ALTER TABLE shops ADD COLUMN IF NOT EXISTS owner_user_id uuid;

DO $$ BEGIN
  ALTER TABLE shops
    ADD CONSTRAINT shops_owner_user_fk
    FOREIGN KEY (owner_user_id) REFERENCES app_users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. sale_lines : isolation par boutique (table enfant, dénormalisation).
--    Nullable pour ne pas casser les lignes existantes, puis backfill
--    depuis la vente parente. Les nouvelles lignes portent le shop_id.
ALTER TABLE sale_lines ADD COLUMN IF NOT EXISTS shop_id uuid;

DO $$ BEGIN
  ALTER TABLE sale_lines
    ADD CONSTRAINT sale_lines_shop_fk
    FOREIGN KEY (shop_id) REFERENCES shops(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

UPDATE sale_lines sl
   SET shop_id = s.shop_id
  FROM sales s
 WHERE sl.sale_id = s.id
   AND sl.shop_id IS NULL;

CREATE INDEX IF NOT EXISTS sale_lines_shop_idx ON sale_lines (shop_id);

-- 3. app_users : index de recherche pour le login (boutique + email).
CREATE UNIQUE INDEX IF NOT EXISTS app_users_shop_email_uq
  ON app_users (shop_id, lower(email)) WHERE email IS NOT NULL;

-- 4. Contrainte de cohérence : un OWNER doit avoir email + mot de passe,
--    un CASHIER un PIN (déjà présente dans schema.sql, rappel idempotent).
DO $$ BEGIN
  ALTER TABLE app_users
    ADD CONSTRAINT app_users_credentials_chk CHECK (
         (role = 'OWNER'   AND email IS NOT NULL AND password_hash IS NOT NULL)
      OR (role = 'CASHIER' AND pin_hash IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
