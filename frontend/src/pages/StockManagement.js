import React, { useState, useEffect } from "react";
import AppShell from "../components/AppShell";
import { useToast } from "../context/KioskContext";
import { apiFetch } from "../api";


const fmt = (d) => new Date(d).toLocaleString("fr-TN");

const TYPE_LABEL = { INITIAL: "Initial", RESTOCK: "Réappro.", SALE: "Vente", ADJUSTMENT: "Ajustement" };
const TYPE_BADGE = { INITIAL: "badge-muted", RESTOCK: "badge-success", SALE: "badge-warn", ADJUSTMENT: "badge-info" };

export default function StockManagement() {
  const toast = useToast();
  const [movements, setMovements] = useState([]);
  const [products,  setProducts]  = useState([]);
  const [form,      setForm]      = useState({ productId: "", quantity: "", reason: "" });
  const [loading,   setLoading]   = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [error,     setError]     = useState("");
  const [showForm,  setShowForm]  = useState(false);

  const loadMovements = () =>
    apiFetch("/stock/movements")
      .then((d) => { setMovements(d.movements || []); setError(""); })
      .catch((err) => setError(err.message || "Chargement impossible."));

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    Promise.all([loadMovements(), apiFetch("/products?all=true")
      .then((d) => { if (!cancelled) setProducts(d.products || []); })
      .catch(() => {})])
      .finally(() => { if (!cancelled) setListLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const quantity = parseFloat(form.quantity);
    if (!form.productId) { toast("Sélectionnez un produit."); return; }
    if (!Number.isFinite(quantity) || quantity === 0) { toast("Quantité invalide (non nulle)."); return; }
    if (form.reason.trim().length < 3) { toast("Le motif doit contenir au moins 3 caractères."); return; }

    setLoading(true);
    try {
      await apiFetch("/stock/adjustment", {
        method: "POST",
        body: JSON.stringify({ productId: form.productId, quantity, reason: form.reason.trim() }),
      });
      toast("Ajustement enregistré ✓");
      setForm({ productId: "", quantity: "", reason: "" });
      setShowForm(false);
      await loadMovements();
    } catch (err) {
      toast(err.message || "Erreur lors de l'ajustement.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AppShell>
      <div className="owner-page">
        <div className="page-header">
          <h1 className="page-title">Mouvements de stock</h1>
          <button className="btn-primary" style={{ width: "auto", padding: "10px 20px" }}
            onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Annuler" : "+ Ajustement"}
          </button>
        </div>

        {error && <p className="error-msg" role="alert">{error}</p>}

        {showForm && (
          <div className="panel mb-2">
            <h2 className="section-title">Ajustement manuel</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="field">
                  <label className="sg-label" htmlFor="sprod">Produit</label>
                  <select id="sprod" className="sg-input" value={form.productId}
                    onChange={(e) => setForm({ ...form, productId: e.target.value })} required>
                    <option value="">— Sélectionner —</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="sg-label" htmlFor="sqty">Quantité (+ ou −)</label>
                  <input id="sqty" className="sg-input" type="number" step="0.001"
                    placeholder="-5 ou +10" value={form.quantity}
                    onChange={(e) => setForm({ ...form, quantity: e.target.value })} required />
                </div>
              </div>
              <div className="field">
                <label className="sg-label" htmlFor="sreason">Motif</label>
                <input id="sreason" className="sg-input" placeholder="Perte, casse, correction…"
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })} required />
              </div>
              <button className="btn-primary" type="submit" disabled={loading} style={{ maxWidth: 220 }}>
                {loading ? "Enregistrement…" : "Enregistrer"}
              </button>
            </form>
          </div>
        )}

        <div className="panel">
          <table className="sg-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Produit</th>
                <th>Type</th>
                <th>Quantité</th>
                <th>Motif / N° Vente</th>
              </tr>
            </thead>
            <tbody>
              {listLoading ? (
                <tr><td colSpan={5} className="empty-state">Chargement…</td></tr>
              ) : movements.length === 0 ? (
                <tr><td colSpan={5} className="empty-state">Aucun mouvement enregistré.</td></tr>
              ) : movements.map((m) => (
                <tr key={m.id}>
                  <td>{fmt(m.createdAt)}</td>
                  <td>{m.productName || "—"}</td>
                  <td>
                    <span className={`badge ${TYPE_BADGE[m.type] || "badge-muted"}`}>
                      {TYPE_LABEL[m.type] || m.type}
                    </span>
                  </td>
                  <td className={m.quantity < 0 ? "text-warn" : "text-success"} style={{ fontWeight: 700 }}>
                    {m.quantity > 0 ? "+" : ""}{m.quantity}
                  </td>
                  <td>
                    {m.saleNumber ? (
                      <span className="sale-ref">
                        <span className="sale-ref-label">Vente</span>
                        <strong>#{m.saleNumber}</strong>
                      </span>
                    ) : (
                      <span className="text-muted">{m.reason || "—"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
