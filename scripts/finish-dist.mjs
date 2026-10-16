// After `vite build`: add the Static Web App config and a version file to app/dist.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('app/package.json', 'utf8'));
copyFileSync('swa/staticwebapp.config.json', 'app/dist/staticwebapp.config.json');
writeFileSync('app/dist/version.json', JSON.stringify({ app: pkg.version, built: new Date().toISOString() }));
console.log('app/dist ready');
