/**
 * Injects BOT_API_URL into the dashboard for Vercel deploys.
 * Set BOT_API_URL in Vercel project settings → Environment Variables.
 * Example: https://your-bot.up.railway.app
 */
const fs = require('fs');
const path = require('path');

const apiUrl = process.env.BOT_API_URL || '';
const htmlPath = path.join(__dirname, '../public/index.html');
let html = fs.readFileSync(htmlPath, 'utf8');

const safeUrl = apiUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
html = html.replace(
  /const BOT_API_URL = '[^']*';/,
  `const BOT_API_URL = '${safeUrl}';`
);

fs.writeFileSync(htmlPath, html);
console.log(`Dashboard API URL set to: ${apiUrl || '(same origin — local dev)'}`);
