// One-shot helper: build the Flutter frontend and copy the output into
// backend/public so the backend folder is shippable on its own.
//
//   cd backend
//   npm run build:web
//
// After this, commit backend/public/ to git — the live server only needs a
// checkout of `backend/` and `npm install && npm start`. It does NOT need a
// Flutter SDK.
//
// Legacy React build is kept as a fallback: pass BUILD_TARGET=react to the
// script if you want the old behavior.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const target = (process.env.BUILD_TARGET || 'flutter').toLowerCase();
const publicDir = path.join(__dirname, '..', 'public');

if (target === 'react') {
  const frontendDir = path.join(__dirname, '..', '..', 'frontend');
  const distDir = path.join(frontendDir, 'dist');
  if (!fs.existsSync(frontendDir)) {
    console.error(`React frontend folder not found at ${frontendDir}`);
    process.exit(1);
  }
  console.log(`› Building React frontend in ${frontendDir} ...`);
  execSync('npm run build', { cwd: frontendDir, stdio: 'inherit', shell: true });
  console.log(`› Replacing ${publicDir}`);
  fs.rmSync(publicDir, { recursive: true, force: true });
  fs.cpSync(distDir, publicDir, { recursive: true });
  console.log(`✓ React build copied to ${publicDir}`);
} else {
  // flutter_app IS the web app. paint_for_doc is the Windows build and has
  // diverged from it: the mobile photo capture sheet, the on-device photo
  // queue, the Photos/Treatments tabs and the Drive gallery are web-only, and
  // paint_for_doc carries desktop-only screens the browser never needs.
  //
  // This used to point at paint_for_doc, which is why backend/public had been
  // serving a build with none of the mobile work in it. Set BUILD_TARGET=paint
  // if you ever genuinely want the desktop app's web output instead.
  const flutterDir = path.join(__dirname, '..', '..',
    (process.env.BUILD_TARGET || '').toLowerCase() === 'paint'
      ? 'paint_for_doc'
      : 'flutter_app');
  const buildDir  = path.join(flutterDir, 'build', 'web');
  if (!fs.existsSync(flutterDir)) {
    console.error(`Flutter folder not found at ${flutterDir}`);
    process.exit(1);
  }
  // Build with an empty BACKEND_URL so the app defaults to same-origin.
  // A live-server admin can still override at runtime by setting
  // APP_API_BASE in backend/.env — no rebuild required.
  console.log(`› Building Flutter web in ${flutterDir} ...`);
  execSync(
    'flutter build web --release --dart-define=BACKEND_URL=""',
    { cwd: flutterDir, stdio: 'inherit', shell: true },
  );
  console.log(`› Replacing ${publicDir}`);
  fs.rmSync(publicDir, { recursive: true, force: true });
  fs.cpSync(buildDir, publicDir, { recursive: true });
  console.log(`✓ Flutter web build copied to ${publicDir}`);
}

console.log('  You can now ship the backend folder on its own.');
console.log('  Live server: set APP_API_BASE in .env if the API is on a different host.');
