# noleaker flow

Google Flow unlock for **Chrome** and **Firefox** (Manifest V3). It works around Google Flow's
regional block on `flow.google.com` and `labs.google/fx/tools/flow`, and does nothing on any other
site. It used to be part of [noleaker](https://github.com/LordVersA/noleaker) and is now its own
extension.

It does **not** route traffic. Flow features that Google also checks on its servers by your IP still
need a proxy or VPN in a supported country (for example noleaker).

## What it does

- **Answers:** a page script wraps `fetch` and `XMLHttpRequest` for `/data/batchexecute`. In the
  `cPZSdc` answer it turns feature flags 31 and 32 on; in the `KV2T2d` answer it rewrites the
  blocked status codes 4, 5, 6 and 8 to 1. It reads JSON and base64 protobuf payloads and repairs
  the length in front of every edited chunk and the total in the closing chunk.
- **Page:** if Flow drew its main screen but none of its answers could be rewritten, the page is
  stopped for about two seconds so it cannot replace that screen with the error.
- **Network:** a `declarativeNetRequest` rule blocks the `unsupported-country` page.
- **Tab:** when that page is reached anyway (blocked load, navigation or Flow's own router), the
  background sends the tab back to `https://flow.google.com/`, keeping `/u/N/`, at most twice a
  minute per tab.

The page script is **not** in the manifest. The background registers it for the two Flow addresses
only while the switch (toolbar popup, on by default) is on, so with the switch off no Flow code is
in the page. Tabs that are already open pick a change up on their next load.

**Firefox:** Firefox lets you withhold host access. If the popup says it has no access to the Flow
pages, click **Allow access to Flow**.

Limits: it depends on a private Google format and will break when Google changes it; the recorded
samples in `tests/unlock.test.ts` are there to show that quickly.

## Privacy

It sends nothing anywhere. It stores the on/off switch, the status of its network rule and a short
diagnostics log in extension storage, and a per-tab list of bounce times in session storage.

## Build from source

```sh
npm install
npm run build          # typecheck + production build to dist/chrome/ and dist/firefox/
npm run dev            # watch mode (dev:firefox for Firefox)
npm test               # run after a build
npm run lint:firefox   # web-ext lint of dist/firefox
npm run start:firefox  # run dist/firefox in a temporary Firefox profile
npm run package        # zip both targets to release/
```

Chrome: load `dist/chrome/` with **Load unpacked**. Firefox: `npm run start:firefox`, or
`about:debugging` → Load Temporary Add-on → `dist/firefox/manifest.json`.

## License

[GPL-3.0](LICENSE).
