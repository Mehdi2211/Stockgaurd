-- =====================================================================
-- 012 : profil créditeur — photo de CIN + consentement
-- =====================================================================
-- Étend la table `customers` (les "créditeurs") :
--   - cin_photo_path : chemin du fichier dans le bucket Supabase PRIVÉ
--     (jamais une URL publique). NULL = aucune photo conservée.
--   - cin_consent_at : date/heure du consentement explicite du créditeur.
--   - pin_hash : n'est plus obligatoire. Aucun login client n'utilise ce
--     champ (le créditeur est sélectionné par le caissier). Les lignes
--     existantes ne sont pas modifiées.
-- Idempotent : peut être relancé sans risque.
-- (Le numéro de CIN `cin` reste NOT NULL : il est saisi au formulaire.)
-- =====================================================================

BEGIN;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS cin_photo_path text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cin_consent_at timestamptz;
ALTER TABLE customers ALTER COLUMN pin_hash DROP NOT NULL;

COMMIT;
