-- =====================================================================
-- 013 : file d'attente des notifications (outbox)
-- =====================================================================
-- Chaque notification (ex. "nouveau profil créditeur") est d'abord
-- enregistree ici, puis envoyee de facon ASYNCHRONE. Un echec ne bloque
-- jamais l'action metier (creation du profil). Le worker reessaie les
-- entrees en 'pending'/'failed' (3 tentatives max, delai croissant).
--
-- Aucune donnee sensible (pas de photo, pas d'URL, pas de n de CIN) ne
-- doit etre stockee dans `payload`.
-- Cette table N'EST PAS append-only : son statut evolue (pending/sent/failed).
-- Idempotent : peut etre relance sans risque.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS notification_outbox (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id     uuid NOT NULL REFERENCES shops(id),
  type        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'sent', 'failed')),
  attempts    smallint NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

CREATE INDEX IF NOT EXISTS notification_outbox_shop_idx
  ON notification_outbox (shop_id, created_at);
CREATE INDEX IF NOT EXISTS notification_outbox_retry_idx
  ON notification_outbox (status, created_at)
  WHERE status IN ('pending', 'failed');

COMMIT;
