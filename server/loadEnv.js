// Minimal .env loader (no dependency). Loads server/.env into process.env if present.
// Real hosts (Render) inject env vars directly, so a missing .env is fine.
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
try {
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const key = s.slice(0, eq).trim();
      let val = s.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  }
} catch (e) {
  console.warn('loadEnv: could not read .env:', e.message);
}
