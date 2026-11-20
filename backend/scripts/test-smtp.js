// =====================================================================
// Vérification de la configuration SMTP + envoi d'un email de test.
//
// Usage :
//   node scripts/test-smtp.js                 -> email au notification_email
//                                                d'une boutique (base par défaut)
//   node scripts/test-smtp.js adresse@ex.com  -> email à l'adresse indiquée
//
// Ne contient AUCUN secret : tout vient de backend/.env
// (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM).
// =====================================================================
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const mailer = require("../src/services/mailer");
const { getDefaultPool } = require("../src/db");

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

(async () => {
  if (!mailer.isConfigured()) {
    console.error(
      "\n[test-smtp] SMTP non configuré.\n" +
      "  Définissez dans backend/.env :\n" +
      "    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM\n" +
      "  Exemples :\n" +
      "    Gmail          : SMTP_HOST=smtp.gmail.com  SMTP_PORT=587  (mot de passe d'application)\n" +
      "    Brevo          : SMTP_HOST=smtp-relay.brevo.com  SMTP_PORT=587\n" +
      "    Resend         : SMTP_HOST=smtp.resend.com  SMTP_PORT=465\n"
    );
    process.exit(1);
  }

  // Destinataire : argument explicite, sinon notification_email d'une boutique.
  let to = (process.argv[2] || process.env.TEST_MAIL_TO || "").trim();
  if (to && !EMAIL_RE.test(to)) {
    console.error(`[test-smtp] Adresse invalide : ${to}`);
    process.exit(1);
  }
  if (!to) {
    try {
      const pool = getDefaultPool();
      const { rows } = await pool.query(
        `SELECT code, notification_email FROM shops
          WHERE notification_email IS NOT NULL
          ORDER BY created_at LIMIT 1`
      );
      if (rows.length > 0) {
        to = rows[0].notification_email;
        console.log(`[test-smtp] destinataire : notification_email de la boutique ${rows[0].code}`);
      }
    } catch (err) {
      console.error("[test-smtp] impossible de lire notification_email :", err.message);
    }
  }
  if (!to) {
    console.error(
      "\n[test-smtp] Aucun destinataire.\n" +
      "  Passez une adresse en argument (node scripts/test-smtp.js a@b.com)\n" +
      "  ou renseignez l'email de notification depuis la page Paramètres de l'application.\n"
    );
    process.exit(1);
  }

  try {
    console.log("[test-smtp] vérification de la connexion SMTP…");
    await mailer.verify();
    console.log("[test-smtp] connexion SMTP OK.");

    const info = await mailer.sendMail({
      to,
      subject: "StockGuard — email de test",
      html: "<p>Ceci est un email de test envoyé par <b>scripts/test-smtp.js</b>. " +
            "Si vous le recevez, votre configuration SMTP est valide.</p>",
      text: "Ceci est un email de test envoyé par scripts/test-smtp.js.",
    });
    console.log(`[test-smtp] email envoyé à ${to} (id: ${info.messageId || "n/a"}).`);
    process.exit(0);
  } catch (err) {
    console.error("[test-smtp] échec :", err.message);
    process.exit(1);
  }
})().catch((err) => {
  console.error("[test-smtp] erreur inattendue :", err);
  process.exit(1);
});
