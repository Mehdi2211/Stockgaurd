-- =====================================================================
-- 010 : Login propriétaire par PIN + liaison Google (OAuth) + email vérifié
-- Idempotent : peut être relancé sans risque.
-- ADDITIF : ne touche pas aux colonnes financières ni à la logique métier.
-- =====================================================================

-- 1. Identité Google : sujet stable renvoyé par Google (id du compte).
--    Sert à lier un compte Google à un utilisateur, par boutique.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS google_sub text;

-- 2. Email vérifié par Google (true uniquement après un flux OAuth).
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_shop_google_sub_uq
  ON app_users (shop_id, google_sub) WHERE google_sub IS NOT NULL;

-- 3. Contrainte d'identifiants : le propriétaire s'authentifie par
--    email + PIN. L'ancien mot de passe reste accepté (compatibilité des
--    comptes existants / tests), mais l'interface n'utilise QUE le PIN.
DO $$ BEGIN
  ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_credentials_chk;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE app_users
    ADD CONSTRAINT app_users_credentials_chk CHECK (
         (role = 'OWNER'
            AND email IS NOT NULL
            AND (pin_hash IS NOT NULL OR password_hash IS NOT NULL))
      OR (role = 'CASHIER' AND pin_hash IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
