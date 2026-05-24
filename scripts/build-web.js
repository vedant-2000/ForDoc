// One-shot helper: build the React frontend and copy the output into
// backend/public so the backend folder is shippable on its own.
//
//   cd backend
//   npm run build:web

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const frontendDir = path.join(__dirname, '..', '..', 'frontend');
const distDir = path.join(frontendDir, 'dist');
const publicDir = path.join(__dirname, '..', 'public');

if (!fs.existsSync(frontendDir)) {
  console.error(`Frontend folder not found at ${frontendDir}`);
  process.exit(1);
}

console.log(`› Building frontend in ${frontendDir} ...`);
execSync('npm run build', { cwd: frontendDir, stdio: 'inherit', shell: true });

console.log(`› Replacing ${publicDir}`);
fs.rmSync(publicDir, { recursive: true, force: true });
fs.cpSync(distDir, publicDir, { recursive: true });

console.log(`✓ Frontend copied to ${publicDir}`);
console.log('  You can now ship the backend folder on its own.');
