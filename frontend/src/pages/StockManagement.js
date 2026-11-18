import React, { useState } from "react";
import AppShell from "../components/AppShell";
import { useToast } from "../context/KioskContext";


const fmt = (d) => new Date(d).toLocaleString("fr-TN");

const TYPE_LABEL = { INITIAL: "Initial", RESTOCK: "Réappro.", SALE: "Vente", ADJUSTMENT: "Ajustement" };
const TYPE_BADGE = { INITIAL: "badge-muted", RESTOCK: "badge-success", SALE: "badge-warn", ADJUSTMENT: "badge-info" };

// Demo movements — replaced by real API later
const DEMO_MOVEMENTS = [
  { id: "m1", createdAt: new Date(Date.now() - 10 * 60000).toISOString(), product: { name: "Lait demi-écrémé 1 L" }, type: "SALE",       quantity: -2,  reason: "Vente #1042",        saleNumber: "1042" },
  { id: "m2", createdAt: new Date(Date.now() - 25 * 60000).toISOString(), product: { name: "Pain baguette" },        type: "SALE",       quantity: -3,  reason: "Vente #1041",        saleNumber: "1041" },
  { id: "m3", createdAt: new Date(Date.now() - 60 * 60000).toISOString(), product: { name: "Huile d'olive 1 L" },    type: "RESTOCK",    quantity: +24, reason: "Réapprovisionnement", saleNumber: null   },
  { id: "m4", createdAt: new Date(Date.now() - 90 * 60000).toISOString(), product: { name: "Harissa 380 g" },        type: "SALE",       quantity: -1,  reason: "Vente #1040",        saleNumber: "1040" },
  { id: "m5", createdAt: new Date(Date.now() - 2 * 3600000).toISOString(),product: { name: "Eau minérale 1,5 L" },   type: "ADJUSTMENT", quantity: -4,  reason: "Perte / casse",      saleNumber: null   },
  { id: "m6", createdAt: new Date(Date.now() - 3 * 3600000).toISOString(),product: { name: "Spaghetti 500 g" },      type: "INITIAL",    quantity: +50, reason: "Stock initial",       saleNumber: null   },
];

const DEMO_PRODUCTS = [
  { id: "1", name: "Lait demi-écrémé 1 L" },
  { id: "2", name: "Pain baguette" },
  { id: "3", name: "Huile d'olive 1 L" },
  { id: "4", name: "Harissa 380 g" },
  { id: "5", name: "Eau minérale 1,5 L" },
  { id: "6", name: "Spaghetti 500 g" },
];

export default function StockManagement() {
  const toast = useToast();
  const [movements, setMovements] = useState(DEMO_MOVEMENTS);
  const [products]                = useState(DEMO_PRODUCTS);
  const [form,      setForm]      = useState({ productId: "", quantity: "", reason: "" });
  const [loading,   setLoading]   = useState(false);
  const [showForm,  setShowForm]  = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    // Demo: add locally
    await new Promise((r) => setTimeout(r, 300));
    const prod = products.find((p) => p.id === form.productId);
    const newMove = {
      id:        "m" + Date.now(),
      createdAt: new Date().toISOString(),
      product:   { name: prod?.name || form.productId },
      type:      "ADJUSTMENT",
      quantity:  parseFloat(form.quantity),
      reason:    form.reason,
      saleNumber: null,
    };
    setMovements((prev) => [newMove, ...prev]);
    toast("Ajustement enregistré ✓");
    setForm({ productId: "", quantity: "", reason: "" });
    setShowForm(false);
    setLoading(false);
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
              {movements.length === 0 ? (
                <tr><td colSpan={5} className="empty-state">Aucun mouvement enregistré.</td></tr>
              ) : movements.map((m) => (
                <tr key={m.id}>
                  <td>{fmt(m.createdAt)}</td>
                  <td>{m.product?.name || "—"}</td>
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
