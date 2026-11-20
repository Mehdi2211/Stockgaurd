import React, { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch, apiUpload } from "../api";
import { formatMillimes } from "../utils/money";
import { compressImage, validateImageFile } from "../utils/image";
import { useToast } from "../context/KioskContext";

// =====================================================================
// Paiement à CRÉDIT : sélecteur de créditeurs + création de profil.
// Ouvre une modale depuis le POS. `total` = total du panier (millimes).
//   - recherche (debounce) + pagination sur la liste des créditeurs ;
//   - un créditeur dont le disponible est insuffisant est affiché mais
//     désactivé, avec la raison ;
//   - « Ajouter un profil » : formulaire avec capture photo + consentement ;
//   - profil sans photo : « Reprendre la photo » (PUT, avec consentement).
// La capture utilise <input type="file" capture="environment"> (pas de
// getUserMedia) : fonctionne sans HTTPS strict et garde un repli fichier.
// =====================================================================

const PAGE_SIZE = 20;
const DEFAULT_CONSENT =
  "La photo de votre CIN est conservée de façon sécurisée par le commerçant " +
  "pour garantir le crédit, et supprimée une fois la dette soldée.";

export default function CreditCheckout({ total, onClose, onConfirm, busy }) {
  const toast = useToast();
  const [mode, setMode] = useState("list");      // "list" | "form"
  const [recapture, setRecapture] = useState(null); // client à re-capturer (PUT)

  // ── Liste ──
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [customers, setCustomers] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);

  // ── Consentement (texte unique côté serveur) ──
  const [consentText, setConsentText] = useState("");
  useEffect(() => {
    apiFetch("/credits/consent-text")
      .then((d) => setConsentText(d.text || ""))
      .catch(() => { /* repli : texte par défaut côté client */ });
  }, []);

  const load = useCallback(async (q, offset) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("search", q);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      const data = await apiFetch(`/credits/customers?${params.toString()}`);
      setCustomers(data.customers || []);
      setTotalCount(data.total || 0);
    } catch (err) {
      toast(err.message || "Erreur de chargement des créditeurs.");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  // Recherche : retour en page 1 + « debounce ».
  useEffect(() => { setPage(0); }, [search]);
  useEffect(() => {
    const t = setTimeout(() => load(search, page * PAGE_SIZE), 300);
    return () => clearTimeout(t);
  }, [search, page, load]);

  const maxPage = Math.max(0, Math.ceil(totalCount / PAGE_SIZE) - 1);

  // ── Formulaire (création OU reprise de photo) ──
  const [firstName, setFirstName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [phone, setPhone] = useState("");
  const [cin, setCin] = useState("");
  const [consent, setConsent] = useState(false);
  const [photo, setPhoto] = useState(null);
  const [preview, setPreview] = useState("");
  const [photoErr, setPhotoErr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const openCreate = () => {
    setRecapture(null);
    setFirstName(""); setFamilyName(""); setPhone(""); setCin("");
    setConsent(false); resetPhoto();
    setMode("form");
  };

  const openRecapture = (c) => {
    setRecapture(c);
    setFirstName(c.firstName); setFamilyName(c.familyName);
    setPhone(c.phone); setCin(c.cin);
    setConsent(false); resetPhoto();
    setMode("form");
  };

  function resetPhoto() {
    setPhoto(null);
    setPhotoErr("");
    setPreview("");
    if (fileRef.current) fileRef.current.value = "";
  }

  const onPickPhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const err = validateImageFile(file);
    if (err) {
      setPhotoErr(err);
      setPhoto(null);
      if (preview) URL.revokeObjectURL(preview);
      setPreview("");
      return;
    }
    setPhotoErr("");
    const compressed = await compressImage(file);
    setPhoto(compressed);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(compressed));
  };

  const retakePhoto = () => resetPhoto();

  const identityOk =
    recapture ||
    (firstName.trim() && familyName.trim() && phone.trim() && cin.trim());

  const canSubmit = identityOk && consent && photo && !submitting && !busy;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append("consent", "true");
      fd.append("cinPhoto", photo);
      if (recapture) {
        await apiUpload(`/credits/customers/${recapture.id}/cin`, fd, { method: "PUT" });
        toast("Photo de CIN mise à jour ✓");
        onConfirm(recapture.id);
      } else {
        fd.append("firstName", firstName.trim());
        fd.append("familyName", familyName.trim());
        fd.append("phone", phone.trim());
        fd.append("cin", cin.trim());
        const data = await apiUpload("/credits/customers", fd);
        toast("Profil créditeur créé ✓");
        onConfirm(data.customer.id);
      }
    } catch (err) {
      toast(err.message || "Erreur lors de l'enregistrement.");
    } finally {
      setSubmitting(false);
    }
  };

  const disabledReason = (c) => {
    if (c.status !== "VALIDATED") return "En attente de validation";
    if (!c.hasCin) return "Photo de CIN manquante";
    if (c.available < total) return `Disponible insuffisant (${formatMillimes(c.available)})`;
    return null;
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box modal-box-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">
            {mode === "list"
              ? "Vente à crédit"
              : recapture
                ? "Reprendre la photo de la CIN"
                : "Nouveau profil créditeur"}
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">✕</button>
        </div>

        <p className="modal-hint">
          Total du panier : <b>{formatMillimes(total)}</b>
        </p>

        {mode === "list" ? (
          <>
            <div className="credit-selector-toolbar">
              <input
                className="sg-input"
                type="search"
                placeholder="Rechercher un créditeur (nom, téléphone…)"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
              <button type="button" className="btn-ghost" onClick={openCreate}>
                + Ajouter un profil
              </button>
            </div>

            {loading ? (
              <p className="empty-state">Chargement…</p>
            ) : customers.length === 0 ? (
              <p className="empty-state">Aucun créditeur trouvé.</p>
            ) : (
              <ul className="credit-picker-list">
                {customers.map((c) => {
                  const reason = disabledReason(c);
                  const needPhoto = c.status === "VALIDATED" && !c.hasCin;
                  return (
                    <li key={c.id} className="credit-picker-item">
                      <button
                        type="button"
                        className="credit-picker-row"
                        disabled={!!reason || busy}
                        onClick={() => onConfirm(c.id)}
                        title={reason || "Sélectionner ce créditeur"}
                      >
                        <span className="credit-picker-info">
                          <b>{c.firstName} {c.familyName}</b>
                          <span className="client-meta">
                            {c.phone}
                            {reason ? ` · ${reason}` : ""}
                          </span>
                        </span>
                        <span className="credit-picker-balance">
                          <span className="client-balance">{formatMillimes(c.balance)}</span>
                          <span className="client-meta">
                            dispo. {formatMillimes(c.available)}
                          </span>
                        </span>
                      </button>
                      {needPhoto && (
                        <button
                          type="button"
                          className="btn-ghost credit-recapture"
                          disabled={busy}
                          onClick={() => openRecapture(c)}
                          title="Le créditeur n'a plus de photo de CIN : reprenez-la"
                        >
                          Reprendre la photo
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {maxPage > 0 && (
              <div className="credit-pagination">
                <button
                  type="button" className="btn-ghost"
                  disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  ‹ Précédent
                </button>
                <span className="hint">Page {page + 1} / {maxPage + 1}</span>
                <button
                  type="button" className="btn-ghost"
                  disabled={page >= maxPage} onClick={() => setPage((p) => p + 1)}
                >
                  Suivant ›
                </button>
              </div>
            )}
          </>
        ) : (
          <form onSubmit={handleSubmit} autoComplete="off">
            {photoErr && <p className="error-msg" role="alert">{photoErr}</p>}

            {recapture ? (
              <p className="hint" style={{ marginBottom: 16 }}>
                {recapture.firstName} {recapture.familyName} · {recapture.phone}
              </p>
            ) : (
              <>
                <div className="form-row">
                  <div className="field">
                    <label className="sg-label" htmlFor="cc-first">Prénom *</label>
                    <input id="cc-first" className="sg-input" value={firstName} maxLength={60}
                      onChange={(e) => setFirstName(e.target.value)} required />
                  </div>
                  <div className="field">
                    <label className="sg-label" htmlFor="cc-last">Nom *</label>
                    <input id="cc-last" className="sg-input" value={familyName} maxLength={60}
                      onChange={(e) => setFamilyName(e.target.value)} required />
                  </div>
                </div>

                <div className="form-row">
                  <div className="field">
                    <label className="sg-label" htmlFor="cc-phone">Téléphone *</label>
                    <input id="cc-phone" className="sg-input" type="tel" inputMode="tel"
                      placeholder="20123456" value={phone}
                      onChange={(e) => setPhone(e.target.value)} required />
                  </div>
                  <div className="field">
                    <label className="sg-label" htmlFor="cc-cin">N° CIN * (8 chiffres)</label>
                    <input id="cc-cin" className="sg-input" inputMode="numeric" maxLength={8}
                      value={cin} onChange={(e) => setCin(e.target.value.replace(/\D/g, ""))} required />
                  </div>
                </div>
              </>
            )}

            <div className="field">
              <label className="sg-label" htmlFor="cc-photo">Photo de la CIN *</label>
              <input
                id="cc-photo"
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={onPickPhoto}
              />
              <p className="hint">
                Utilisez la caméra sur mobile/tablette, ou choisissez un fichier (JPEG, PNG, WEBP · 5 Mo max).
              </p>
              {preview && (
                <div className="cin-preview">
                  <img src={preview} alt="Aperçu de la CIN" />
                  <button type="button" className="btn-ghost" onClick={retakePhoto}>
                    Reprendre la photo
                  </button>
                </div>
              )}
            </div>

            <div className="field consent-box">
              <label className="consent-label">
                <input type="checkbox" checked={consent}
                  onChange={(e) => setConsent(e.target.checked)} required />
                <span>{consentText || DEFAULT_CONSENT}</span>
              </label>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={() => setMode("list")}>
                Retour
              </button>
              <button type="submit" className="btn-primary" style={{ flex: 1 }} disabled={!canSubmit}>
                {submitting ? "Enregistrement…" : recapture ? "Enregistrer la photo" : "Créer le profil"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
