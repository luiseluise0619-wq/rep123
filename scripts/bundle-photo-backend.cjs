// One-file Apps Script paste, without ever bundling account secrets.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const gs = fs.readFileSync(path.join(root, 'photo-backend/Code.gs'), 'utf8');
const html = fs.readFileSync(path.join(root, 'photo-backend/Photo.html'), 'utf8');
const out = path.resolve(process.argv[2] || path.join(root, '../work/mybox-photo-bundle.gs'));
fs.writeFileSync(out, gs + '\nvar PHOTO_HTML_ = ' + JSON.stringify(html) + ';\n', 'utf8');
console.log(JSON.stringify({path: out, bytes: fs.statSync(out).size}));
