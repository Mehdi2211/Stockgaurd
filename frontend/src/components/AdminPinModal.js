import React, { useState, useEffect, useRef } from "react";
import { useKiosk } from "../context/KioskContext";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../api";


const PIN_RE = /^[0-9]{4,8}$/;

// Accès administrateur : le propriétaire se connecte avec le code de la
// boutique courante + son PIN d'administration (aucun email/mot de passe).
// Le jeton OWNER renvoyé remplace le jeton caissier actif.
export default function AdminPinModal({ onClose }) {
  const { kiosk, elevate } = useKiosk();
  const navigate           = useNavigate();
  const [pin,     setPin]     = useState("");
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (!kiosk?.code) { setError("Boutique inconnue, reconnectez-vous."); return; }
    if (!PIN_RE.test(pin.trim())) { setError("Le PIN doit contenir 4 à 8 chiffres."); return; }
    setLoading(true);
    try {
      const data = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ code: kiosk.code, pin: pin.trim(), role: "OWNER" }),
        authRedirect: false,
      });
      if (data.user.role !== "OWNER") {
        setError("Ce PIN n'est pas celui d'un propriétaire.");
        setLoading(false);
        return;
      }
      elevate({ token: data.token });
      onClose();
      navigate("/owner");
    } catch (err) {
      setError(err.message || "Identifiants invalides.");
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Accès Administration</h2>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">✕</button>
        </div>

        <p className="modal-hint">Saisissez le PIN d&apos;administration pour accéder au tableau de bord.</p>

        <form onSubmit={handleSubmit} autoComplete="off">
          {error && <p className="error-msg" role="alert">{error}</p>}

          <div className="field">
            <label className="sg-label" htmlFor="adminPin">PIN d&apos;administration</label>
            <input
              id="adminPin"
              ref={inputRef}
              className="sg-input code"
              type="password"
              inputMode="numeric"
              placeholder="••••"
              maxLength={8}
              value={pin}
              onChange={(e) => { setPin(e.target.value.replace(/\D/g, "")); setError(""); }}
              required
            />
          </div>

          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Annuler</button>
            <button type="submit" className="btn-primary" style={{ flex: 1 }} disabled={loading}>
              {loading ? "Connexion…" : "Accéder"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
