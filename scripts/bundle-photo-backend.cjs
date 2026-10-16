// One-file Apps Script paste, without ever bundling account secrets.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const gs = ['Code.gs','Access.gs','Catalog.gs','Public.gs','Capture.gs','Diagnostics.gs'].map(name=>fs.readFileSync(path.join(root,'photo-backend',name),'utf8')).join('\n');
const html = fs.readFileSync(path.join(root, 'photo-backend/Photo.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'photo-backend/Admin.html'), 'utf8');
const out = path.resolve(process.argv[2] || path.join(root, '../work/mybox-photo-bundle.gs'));
const bridge=fs.readFileSync(path.join(root,'photo-backend/Bridge.html'),'utf8'),landing=fs.readFileSync(path.join(root,'photo-backend/Landing.html'),'utf8');
const diagnostic=fs.readFileSync(path.join(root,'photo-backend/assets/mybox-connection-test.jpg')).toString('base64');
fs.writeFileSync(out, gs + '\nvar PHOTO_DIAG_JPEG_ = '+JSON.stringify(diagnostic)+';\nvar PHOTO_HTML_ = ' + JSON.stringify(html) + ';\nvar PHOTO_ADMIN_HTML_ = '+JSON.stringify(admin)+';\nvar PHOTO_BRIDGE_HTML_ = '+JSON.stringify(bridge)+';\nvar PHOTO_LANDING_HTML_ = '+JSON.stringify(landing)+';\n', 'utf8');
console.log(JSON.stringify({path: out, bytes: fs.statSync(out).size}));
