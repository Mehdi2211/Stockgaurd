const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["'"'"']|["'"'"']$/g, "");
  }
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const shops = await pool.query(`SELECT id, name, code, created_at FROM shops ORDER BY created_at`);
  console.log("=== BOUTIQUES (" + shops.rows.length + ") ===");
  for (const s of shops.rows) {
    const cm = await pool.query(`SELECT type, COUNT(*)::int n FROM cash_movements WHERE shop_id=$1 GROUP BY type`, [s.id]);
    const cv = await pool.query(`SELECT COUNT(*)::int n FROM cash_verifications WHERE shop_id=$1`, [s.id]);
    const sales = await pool.query(`SELECT COUNT(*)::int n FROM sales WHERE shop_id=$1`, [s.id]);
    const credits = await pool.query(`SELECT COUNT(*)::int n FROM credits WHERE shop_id=$1`, [s.id]);
    console.log(`${s.name} [${s.code}] id=${s.id}`);
    console.log(`  cash_movements: ${JSON.stringify(cm.rows)} | verifications: ${cv.rows[0].n} | sales: ${sales.rows[0].n} | credits: ${credits.rows[0].n}`);
  }
  // INITIALIZATION par boutique
  const inits = await pool.query(`SELECT shop_id, amount, effective_at, created_at FROM cash_movements WHERE type='INITIALIZATION' ORDER BY created_at`);
  console.log("=== LIGNES INITIALIZATION (" + inits.rows.length + ") ===");
  for (const r of inits.rows) console.log(`shop=${r.shop_id} amount=${r.amount} effective_at=${r.effective_at} created_at=${r.created_at}`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
