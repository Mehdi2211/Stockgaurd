import React, { useState, useEffect } from "react";
import AppShell from "../components/AppShell";
import { apiFetch } from "../api";
import { useToast } from "../context/KioskContext";

// =====================================================================
// Paramètres de la boutique (OWNER).
// Permet de modifier l'email de notification utilisé pour prévenir le
// propriétaire (ex. création d'un profil créditeur). Champ optionnel.
// =====================================================================

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function Settings() {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiFetch("/shop/me")
      .then((d) => { if (!cancelled) setEmail(d.shop?.notificationEmail || ""); })
      .catch((err) => { if (!cancelled) setError(err.message || "Chargement impossible."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const save = async (e) => {
    e.preventDefault();
    const v = email.trim();
    if (v !== "" && !EMAIL_RE.test(v)) { setError("Adresse email invalide."); return; }
    setSaving(true);
    setError("");
    try {
      await apiFetch("/shop/notification-email", {
        method: "PUT",
        body: JSON.stringify({ notificationEmail: v }),
      });
      toast("Email de notification enregistré ✓");
    } catch (err) {
      setError(err.message || "Erreur lors de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell>
      <div className="owner-page">
        <div className="page-header">
          <h1 className="page-title">Paramètres</h1>
        </div>

        {error && <p className="error-msg" role="alert">{error}</p>}

        {loading ? (
          <p className="empty-state">Chargement…</p>
        ) : (
          <div className="panel settings-form">
            <h2 className="section-title">Notifications</h2>
            <p className="hint" style={{ marginBottom: 16 }}>
              Adresse recevant les notifications (ex. nouveau profil créditeur). Ce n&apos;est pas un
              email de connexion : vous vous connectez avec votre PIN. Laissez vide pour désactiver.
            </p>
            <form onSubmit={save} autoComplete="off">
              <div className="field">
                <label className="sg-label" htmlFor="notifEmail">Email de notification</label>
                <input
                  id="notifEmail"
                  className="sg-input"
                  type="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(""); }}
                  placeholder="ex. patron@example.com"
                />
              </div>
              <button className="btn-primary" type="submit" disabled={saving}>
                {saving ? "Enregistrement…" : "Enregistrer"}
              </button>
            </form>
          </div>
        )}
      </div>
    </AppShell>
  );
}
