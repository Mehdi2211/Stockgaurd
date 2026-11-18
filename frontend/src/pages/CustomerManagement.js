import React, { useState, useEffect } from "react";
import AppShell from "../components/AppShell";
import { useToast } from "../context/KioskContext";


const dt = (m) => (m / 1000).toFixed(3) + " DT";

const STATUS_LABEL = { PENDING: "En attente", VALIDATED: "Validé", REJECTED: "Rejeté" };
const STATUS_BADGE = { PENDING: "badge-warn", VALIDATED: "badge-success", REJECTED: "badge-danger" };

const EMPTY = { firstName: "", familyName: "", phone: "", cin: "" };

export default function CustomerManagement() {
  const toast = useToast();
  const [customers, setCustomers] = useState([]);
  const [form,      setForm]      = useState(EMPTY);
  const [showForm,  setShowForm]  = useState(false);
  const [loading,   setLoading]   = useState(false);

  const load = () =>
    fetch("/api/customers")
      .then((r) => r.json())
      .then((d) => setCustomers(d.customers || []))
      .catch(() => toast("Erreur de chargement."));

  useEffect(() => { load(); }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      toast("Client créé ✓");
      setForm(EMPTY);
      setShowForm(false);
      load();
    } catch (err) {
      toast(err.message || "Erreur lors de la création.");
    } finally { setLoading(false); }
  };

  const handleValidate = async (id, action) => {
    try {
      const res = await fetch(`/api/customers/${id}/${action}`, { method: "POST" });
      if (!res.ok) throw new Error();
      toast(action === "validate" ? "Client validé ✓" : "Client rejeté.");
      load();
    } catch { toast("Erreur lors de la mise à jour."); }
  };

  return (
    <AppShell>
      <div className="owner-page">
        <div className="page-header">
          <h1 className="page-title">Clients</h1>
          <button className="btn-primary" style={{ width: "auto", padding: "10px 20px" }}
            onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Annuler" : "+ Nouveau client"}
          </button>
        </div>

        {showForm && (
          <div className="panel mb-2">
            <h2 className="section-title">Ajouter un client</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="field">
                  <label className="sg-label" htmlFor="firstName">Prénom</label>
                  <input id="firstName" className="sg-input" value={form.firstName}
                    onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />
                </div>
                <div className="field">
                  <label className="sg-label" htmlFor="familyName">Nom de famille</label>
                  <input id="familyName" className="sg-input" value={form.familyName}
                    onChange={(e) => setForm({ ...form, familyName: e.target.value })} required />
                </div>
              </div>
              <div className="form-row">
                <div className="field">
                  <label className="sg-label" htmlFor="phone">Téléphone</label>
                  <input id="phone" className="sg-input" type="tel" value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div className="field">
                  <label className="sg-label" htmlFor="cin">CIN</label>
                  <input id="cin" className="sg-input" value={form.cin}
                    onChange={(e) => setForm({ ...form, cin: e.target.value })} />
                </div>
              </div>
              <button className="btn-primary" type="submit" disabled={loading} style={{ maxWidth: 220 }}>
                {loading ? "Enregistrement…" : "Créer le client"}
              </button>
            </form>
          </div>
        )}

        <div className="panel">
          <table className="sg-table">
            <thead>
              <tr>
                <th>Nom</th>
                <th>CIN</th>
                <th>Téléphone</th>
                <th>Solde</th>
                <th>Statut</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {customers.length === 0 ? (
                <tr><td colSpan={6} className="empty-state">Aucun client enregistré.</td></tr>
              ) : customers.map((c) => (
                <tr key={c.id}>
                  <td>{c.firstName} {c.familyName}</td>
                  <td>{c.cin || "—"}</td>
                  <td>{c.phone || "—"}</td>
                  <td className={c.balance > 0 ? "text-warn" : ""}>{dt(c.balance)}</td>
                  <td><span className={`badge ${STATUS_BADGE[c.status]}`}>{STATUS_LABEL[c.status]}</span></td>
                  <td>
                    {c.status === "PENDING" && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: ".85rem" }}
                          onClick={() => handleValidate(c.id, "validate")}>Valider</button>
                        <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: ".85rem", color: "var(--warn)" }}
                          onClick={() => handleValidate(c.id, "reject")}>Rejeter</button>
                      </div>
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
