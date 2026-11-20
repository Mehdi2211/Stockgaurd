import React, { useState, useEffect, useRef } from "react";
import AppShell from "../components/AppShell";
import ScanPanel from "../components/ScanPanel";
import CreditCheckout from "../components/CreditCheckout";
import { useToast } from "../context/KioskContext";
import { apiFetch } from "../api";


const dt = (m) => (m / 1000).toFixed(3) + " DT";

export default function CashierPOS() {
  const toast     = useToast();
  const [products, setProducts] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [loadError,setLoadError]= useState("");
  const [query,    setQuery]    = useState("");
  const [cart,     setCart]     = useState(new Map());
  const [selling,  setSelling]  = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  // Identifiant de vente généré une fois par panier : une nouvelle
  // tentative après échec réutilise le même id (idempotence serveur).
  const saleIdRef  = useRef(null);

  useEffect(() => {
    // Produits réels de la boutique (via le jeton) — plus de mock.
    let cancelled = false;
    setLoading(true);
    apiFetch("/products")
      .then((d) => { if (!cancelled) { setProducts(d.products || []); setLoadError(""); } })
      .catch((err) => { if (!cancelled) setLoadError(err.message || "Chargement impossible."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = products.filter(
    (p) =>
      p.isActive &&
      (p.name.toLowerCase().includes(query.toLowerCase()) ||
        (p.barcode && p.barcode.includes(query)))
  );

  const addToCart = (product) => {
    setCart((prev) => {
      const next = new Map(prev);
      next.set(product.id, { product, qty: (prev.get(product.id)?.qty || 0) + 1 });
      return next;
    });
  };

  const removeFromCart = (id) => {
    setCart((prev) => { const next = new Map(prev); next.delete(id); return next; });
  };

  const changeQty = (id, delta) => {
    setCart((prev) => {
      const next = new Map(prev);
      const item = next.get(id);
      if (!item) return prev;
      const newQty = item.qty + delta;
      if (newQty <= 0) next.delete(id);
      else next.set(id, { ...item, qty: newQty });
      return next;
    });
  };

  const cartTotal = [...cart.values()].reduce(
    (sum, { product, qty }) => sum + product.price * qty, 0
  );

  const handleCash = async () => {
    if (!cart.size) { toast("Le panier est vide."); return; }
    if (selling) return;

    if (!saleIdRef.current) saleIdRef.current = crypto.randomUUID();

    setSelling(true);
    try {
      await apiFetch("/sales", {
        method: "POST",
        body: JSON.stringify({
          id: saleIdRef.current,
          lines: [...cart.values()].map(({ product, qty }) => ({
            productId: product.id,
            quantity: qty,
          })),
        }),
      });
      toast("Vente enregistrée en espèces ✓");
      setCart(new Map());
      saleIdRef.current = null;
      setQuery("");
    } catch (err) {
      // Le panier est conservé : une nouvelle tentative réutilise le
      // même identifiant de vente (pas de doublon côté serveur).
      toast(err.message || "Erreur lors de l'enregistrement de la vente.");
    } finally {
      setSelling(false);
    }
  };

  const handleCredit = () => {
    if (!cart.size) { toast("Le panier est vide."); return; }
    if (selling) return;
    setCreditOpen(true);
  };

  // Confirmation de la vente à crédit : le serveur crée la vente ET la
  // dette dans UNE transaction. Si la dette est refusée (plafond), rien
  // n'est enregistré et la modale reste ouverte pour choisir un autre
  // créditeur.
  const confirmCredit = async (customerId) => {
    if (!cart.size || selling) return;
    if (!saleIdRef.current) saleIdRef.current = crypto.randomUUID();
    setSelling(true);
    try {
      await apiFetch("/sales", {
        method: "POST",
        body: JSON.stringify({
          id: saleIdRef.current,
          customerId,
          lines: [...cart.values()].map(({ product, qty }) => ({
            productId: product.id,
            quantity: qty,
          })),
        }),
      });
      toast("Vente à crédit enregistrée ✓");
      setCart(new Map());
      saleIdRef.current = null;
      setQuery("");
      setCreditOpen(false);
    } catch (err) {
      // Panier conservé : nouvelle tentative avec le même id de vente.
      toast(err.message || "Erreur lors de l'enregistrement de la vente à crédit.");
    } finally {
      setSelling(false);
    }
  };

  return (
    <AppShell>
      <div className="pos-layout">
        {/* Left: scan + product grid */}
        <div className="panel">
          <ScanPanel onProductMatched={addToCart} />

          <label className="sr" htmlFor="search">Rechercher un produit</label>
          <input
            id="search"
            className="sg-input"
            type="search"
            placeholder="Rechercher un produit par nom ou code-barres"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {loadError && <p className="error-msg" role="alert">{loadError}</p>}

          <div className="product-grid">
            {loading ? (
              <p className="empty-state" style={{ gridColumn: "1/-1" }}>Chargement des produits…</p>
            ) : filtered.length === 0 ? (
              <p className="empty-state" style={{ gridColumn: "1/-1" }}>
                Aucun produit trouvé. Seul le propriétaire peut créer un nouveau code-barres.
              </p>
            ) : (
              filtered.map((p) => (
                <button key={p.id} className="prod-card" type="button" onClick={() => addToCart(p)}>
                  <b>{p.name}</b>
                  <span>{dt(p.price)}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right: cart */}
        <div className="panel cart-panel">
          <h2>Panier</h2>

          {cart.size === 0 ? (
            <p className="empty-state">Scannez un produit pour commencer.</p>
          ) : (
            <ul className="cart-list">
              {[...cart.values()].map(({ product, qty }) => (
                <li key={product.id} className="cart-item">
                  <div className="cart-item-info">
                    <span className="cart-item-name">{product.name}</span>
                    <span className="cart-item-sub">{dt(product.price)} / unité</span>
                  </div>
                  <div className="cart-item-controls">
                    <button className="qty-btn" onClick={() => changeQty(product.id, -1)}>−</button>
                    <span className="qty-val">{qty}</span>
                    <button className="qty-btn" onClick={() => changeQty(product.id, +1)}>+</button>
                    <button className="qty-del" onClick={() => removeFromCart(product.id)} aria-label="Supprimer">✕</button>
                  </div>
                  <span className="cart-item-total">{dt(product.price * qty)}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="cart-total">
            <span>Total</span>
            <span>{dt(cartTotal)}</span>
          </div>

          <div className="pay-grid">
            <button className="btn-pay" onClick={handleCash} disabled={selling}>
              {selling && !creditOpen ? "Enregistrement…" : "Espèces"}
            </button>
            <button className="btn-pay alt" onClick={handleCredit} disabled={selling || !cart.size}>
              Crédit
            </button>
          </div>
        </div>
      </div>

      {creditOpen && (
        <CreditCheckout
          total={cartTotal}
          busy={selling}
          onClose={() => setCreditOpen(false)}
          onConfirm={confirmCredit}
        />
      )}
    </AppShell>
  );
}
