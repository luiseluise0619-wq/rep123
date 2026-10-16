// One-file Apps Script paste, without ever bundling account secrets.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const gs = ['Code.gs','Access.gs','Catalog.gs','Public.gs'].map(name=>fs.readFileSync(path.join(root,'photo-backend',name),'utf8')).join('\n');
const html = fs.readFileSync(path.join(root, 'photo-backend/Photo.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'photo-backend/Admin.html'), 'utf8');
const out = path.resolve(process.argv[2] || path.join(root, '../work/mybox-photo-bundle.gs'));
fs.writeFileSync(out, gs + '\nvar PHOTO_HTML_ = ' + JSON.stringify(html) + ';\nvar PHOTO_ADMIN_HTML_ = '+JSON.stringify(admin)+';\n', 'utf8');
console.log(JSON.stringify({path: out, bytes: fs.statSync(out).size}));
