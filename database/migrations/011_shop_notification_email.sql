-- =====================================================================
-- 011 : email de notification de la boutique (propriétaire)
-- =====================================================================
-- `shops.notification_email` sert UNIQUEMENT aux notifications (ex. création
-- d'un profil créditeur). Ce n'est PAS un email de connexion : le login
-- reste par PIN (app_users.pin_hash) et n'est pas touché ici.
-- Idempotent : peut être relancé sans risque.
-- =====================================================================

BEGIN;

ALTER TABLE shops ADD COLUMN IF NOT EXISTS notification_email text;

DO $$ BEGIN
  ALTER TABLE shops
    ADD CONSTRAINT shops_notification_email_fmt_chk
    CHECK (
      notification_email IS NULL
      OR notification_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
