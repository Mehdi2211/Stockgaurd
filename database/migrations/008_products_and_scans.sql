-- =====================================================================
-- 008 : Produits (updated_at) + journal des scans (product_scans)
-- Idempotent : peut être relancé sans risque.
-- Le scan N'AFFECTE NI le stock NI la caisse (préparation vente future).
-- =====================================================================

-- 1. Produits : date de dernière modification.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- 2. Journal des scans de produits.
--    product_id nullable : un code inconnu est tout de même journalisé
--    (status = 'unknown') pour permettre la création ultérieure.
CREATE TABLE IF NOT EXISTS product_scans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id),
  product_id  uuid REFERENCES products(id),
  barcode     text NOT NULL CHECK (length(btrim(barcode)) BETWEEN 1 AND 32),
  quantity    numeric(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  scanned_by  uuid NOT NULL REFERENCES app_users(id),
  scanned_at  timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'matched'
              CHECK (status IN ('matched', 'unknown', 'sold', 'cancelled')),
  sale_id     uuid REFERENCES sales(id),
  -- Cohérence : un scan 'unknown' ne peut pas référencer un produit.
  CONSTRAINT product_scans_unknown_chk
    CHECK ((status = 'unknown') = (product_id IS NULL))
);

-- Index de filtre fréquents (période, utilisateur, code-barres).
CREATE INDEX IF NOT EXISTS product_scans_shop_scanned_idx
  ON product_scans (shop_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS product_scans_shop_barcode_idx
  ON product_scans (shop_id, barcode);
CREATE INDEX IF NOT EXISTS product_scans_shop_user_idx
  ON product_scans (shop_id, scanned_by, scanned_at DESC);
CREATE INDEX IF NOT EXISTS product_scans_sale_idx
  ON product_scans (sale_id) WHERE sale_id IS NOT NULL;
