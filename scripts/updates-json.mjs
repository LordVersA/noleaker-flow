// Write release/updates.json, the Firefox self-hosted update manifest that the gecko `update_url`
// points to (releases/latest/download/updates.json). Run after the signed .xpi is in release/.
import { readFileSync, writeFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('manifests/manifest.firefox.json', 'utf8'));
const { id, strict_min_version } = manifest.browser_specific_settings.gecko;
const { version } = manifest;
const repo = process.env.GITHUB_REPOSITORY ?? 'LordVersA/noleaker-flow';
const updates = {
  addons: {
    [id]: {
      updates: [
        {
          version,
          update_link: `https://github.com/${repo}/releases/download/v${version}/noleaker-flow-firefox-${version}.xpi`,
          applications: { gecko: { strict_min_version } },
        },
      ],
    },
  },
};
writeFileSync('release/updates.json', `${JSON.stringify(updates, null, 2)}\n`);
console.log(`wrote release/updates.json for ${id} ${version}`);
