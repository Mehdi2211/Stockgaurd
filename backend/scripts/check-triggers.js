const fs=require("fs"),path=require("path");
const env=path.join("C:/Users/User/Desktop/PROJET STOCKGUARD/backend",".env");
for(const l of fs.readFileSync(env,"utf8").split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,"");}
const{Pool}=require("C:/Users/User/Desktop/PROJET STOCKGUARD/backend/node_modules/pg");
const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
p.query("SELECT tgname, tgrelid::regclass::text AS tbl FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'cash%' ORDER BY 2,1")
 .then(r=>{console.log(JSON.stringify(r.rows,null,1));return p.end();})
 .catch(e=>{console.error(e.message);process.exit(1);});
