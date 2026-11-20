import React, { useState, useEffect } from "react";
import { apiFetch } from "../api";
import { useToast } from "../context/KioskContext";

// =====================================================================
// Modale affichée au PROPRIÉTAIRE après connexion si l'email de
// notification de la boutique est vide. L'email sert uniquement aux
// notifications (ex. nouveau profil créditeur) : ce n'est PAS un email
// de connexion (le login reste par PIN).
//
// Montée dans AppShell quand role === "OWNER". « Plus tard » mémorise le
// report pour la session en cours (sessionStorage).
// =====================================================================

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SKIP_KEY = "sg_email_prompt_skipped";

export default function NotificationEmailModal() {
  const toast = useToast();
  const [visible, setVisible] = useState(false);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (sessionStorage.getItem(SKIP_KEY) === "1") return;
    let cancelled = false;
    apiFetch("/shop/me")
      .then((d) => {
        if (cancelled) return;
        if (!d.shop?.notificationEmail) {
          setEmail("");
          setVisible(true);
        }
      })
      .catch(() => { /* l'API gère la redirection 401 */ });
    return () => { cancelled = true; };
  }, []);

  const skip = () => {
    sessionStorage.setItem(SKIP_KEY, "1");
    setVisible(false);
  };

  const save = async (e) => {
    e.preventDefault();
    const v = email.trim();
    if (!EMAIL_RE.test(v)) { setError("Adresse email invalide."); return; }
    setSaving(true);
    setError("");
    try {
      await apiFetch("/shop/notification-email", {
        method: "PUT",
        body: JSON.stringify({ notificationEmail: v }),
      });
      sessionStorage.setItem(SKIP_KEY, "1");
      toast("Email de notification enregistré ✓");
      setVisible(false);
    } catch (err) {
      setError(err.message || "Erreur lors de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;

  return (
    <div className="modal-backdrop" onClick={skip}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Email de notification</h2>
          <button className="modal-close" onClick={skip} aria-label="Fermer">✕</button>
        </div>

        <p className="modal-hint">
          Renseignez l&apos;adresse qui recevra les notifications (nouveau profil créditeur).
          Ce n&apos;est PAS un email de connexion : vous vous connectez avec votre PIN.
        </p>

        <form onSubmit={save} autoComplete="off">
          {error && <p className="error-msg" role="alert">{error}</p>}

          <div className="field">
            <label className="sg-label" htmlFor="notifEmail">Email de notification</label>
            <input
              id="notifEmail"
              className="sg-input"
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(""); }}
              placeholder="ex. patron@example.com"
              required
              autoFocus
            />
          </div>

          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={skip}>Plus tard</button>
            <button type="submit" className="btn-primary" style={{ flex: 1 }} disabled={saving}>
              {saving ? "Enregistrement…" : "Enregistrer"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
