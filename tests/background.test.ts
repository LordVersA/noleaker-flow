/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listenForFlowBounce, syncFlowScript } from '../src/background/flow';
import { FLOW_BLOCK_ID, flowRules, syncFlowRule } from '../src/background/rules';
import { isBlockedNavigationError as chromeBlocked } from '../src/platform/chrome/navigation';
import { isBlockedNavigationError as firefoxBlocked } from '../src/platform/firefox/navigation';
import { FLOW_MATCHES, UNSUPPORTED_ROUTE_REGEX } from '../src/flow/urls';
import { ENABLED_KEY, isEnabled, RULE_STATUS_KEY } from '../src/shared/settings';

let local: Record<string, unknown>;
let session: Record<string, unknown>;
let installed: { id: number }[];
let registered: any[];
let failRule: boolean;
const updates: any[] = [];

const area = (store: () => Record<string, unknown>) => ({
  get: async (key: string) => (key in store() ? { [key]: store()[key] } : {}),
  set: async (items: Record<string, unknown>) => void Object.assign(store(), items),
  remove: async (key: string) => void delete store()[key],
});

const listeners: Record<string, ((d: any) => void)[]> = {};
const on = (name: string) => ({
  addListener: (fn: (d: any) => void) => (listeners[name] ??= []).push(fn),
});
const fire = (name: string, details: any) => listeners[name]!.forEach((fn) => fn(details));
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  local = {};
  session = {};
  installed = [];
  registered = [];
  failRule = false;
  updates.length = 0;
  for (const k of Object.keys(listeners)) delete listeners[k];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('chrome', {
    storage: { local: area(() => local), session: area(() => session) },
    declarativeNetRequest: {
      updateDynamicRules: async ({
        removeRuleIds,
        addRules,
      }: {
        removeRuleIds: number[];
        addRules: { id: number }[];
      }) => {
        if (failRule && addRules.length > 0) throw new Error('bad regex');
        installed = [...installed.filter((r) => !removeRuleIds.includes(r.id)), ...addRules];
      },
    },
    scripting: {
      getRegisteredContentScripts: async ({ ids }: { ids: string[] }) =>
        registered.filter((s) => ids.includes(s.id)),
      registerContentScripts: async (scripts: any[]) => void registered.push(...scripts),
      updateContentScripts: async (scripts: any[]) => {
        for (const s of scripts) registered = registered.map((r) => (r.id === s.id ? s : r));
      },
      unregisterContentScripts: async ({ ids }: { ids: string[] }) => {
        registered = registered.filter((s) => !ids.includes(s.id));
      },
    },
    webNavigation: {
      onCommitted: on('committed'),
      onHistoryStateUpdated: on('history'),
      onErrorOccurred: on('error'),
    },
    tabs: {
      onRemoved: on('removed'),
      update: async (tabId: number, props: { url: string }) =>
        void updates.push([tabId, props.url]),
    },
  });
});

describe('switch', () => {
  it('is on by default and keeps an explicit off', async () => {
    expect(await isEnabled()).toBe(true);
    local[ENABLED_KEY] = false;
    expect(await isEnabled()).toBe(false);
  });
});

describe('Flow network rule', () => {
  it('is a block rule for the country route in frames only', () => {
    const [rule] = flowRules(true);
    expect(rule).toMatchObject({
      id: FLOW_BLOCK_ID,
      action: { type: 'block' },
      condition: {
        regexFilter: UNSUPPORTED_ROUTE_REGEX,
        resourceTypes: ['main_frame', 'sub_frame'],
      },
    });
    expect(flowRules(false)).toEqual([]);
  });
  it('is installed while on and removed when off', async () => {
    await syncFlowRule(true);
    expect(installed.map((r) => r.id)).toEqual([FLOW_BLOCK_ID]);
    expect(local[RULE_STATUS_KEY]).toMatchObject({ ok: true });
    await syncFlowRule(false);
    expect(installed).toEqual([]);
  });
  it('a failure is stored for the popup and does not throw', async () => {
    failRule = true;
    await expect(syncFlowRule(true)).resolves.toBeUndefined();
    expect(local[RULE_STATUS_KEY]).toMatchObject({ ok: false, error: 'bad regex' });
  });
});

describe('Flow script registration', () => {
  it('registers a MAIN-world document_start script for the two Flow addresses when on', async () => {
    await syncFlowScript(true);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      matches: FLOW_MATCHES,
      js: ['content/flow.js'],
      runAt: 'document_start',
      world: 'MAIN',
      persistAcrossSessions: true,
    });
  });
  it('keeps one registration however often it syncs, and removes it when off', async () => {
    await syncFlowScript(true);
    await syncFlowScript(true);
    expect(registered).toHaveLength(1);
    await syncFlowScript(false);
    expect(registered).toHaveLength(0);
    await syncFlowScript(false); // nothing to remove: no error
    expect(registered).toHaveLength(0);
  });
  it('does not throw when the browser refuses', async () => {
    (chrome.scripting as any).registerContentScripts = async () => {
      throw new Error('Duplicate script ID');
    };
    await expect(syncFlowScript(true)).resolves.toBeUndefined();
  });
});

describe('Flow bounce', () => {
  const country = 'https://flow.google.com/u/1/unsupported-country';

  beforeEach(() => listenForFlowBounce());

  it('sends the tab home after a normal navigation, a router move, or a blocked load', async () => {
    fire('committed', { tabId: 7, frameId: 0, url: country });
    await settle();
    expect(updates).toEqual([[7, 'https://flow.google.com/u/1/']]);
    fire('removed', 7); // a fresh tab id resets the limiter
    await settle();
    fire('history', { tabId: 8, frameId: 0, url: country });
    fire('error', { tabId: 9, frameId: 0, url: country, error: 'net::ERR_BLOCKED_BY_CLIENT' });
    await settle();
    expect(updates.map((u) => u[0])).toEqual([7, 8, 9]);
  });
  it('ignores subframes, other pages, other errors and the switch being off', async () => {
    fire('committed', { tabId: 1, frameId: 3, url: country });
    fire('committed', { tabId: 1, frameId: 0, url: 'https://flow.google.com/project/1' });
    fire('error', { tabId: 1, frameId: 0, url: country, error: 'net::ERR_NAME_NOT_RESOLVED' });
    fire('committed', { tabId: -1, frameId: 0, url: country });
    local[ENABLED_KEY] = false;
    fire('committed', { tabId: 2, frameId: 0, url: country });
    await settle();
    expect(updates).toEqual([]);
  });
  it('bounces at most twice a minute per tab, even when two events arrive together', async () => {
    for (let i = 0; i < 3; i++) {
      fire('committed', { tabId: 5, frameId: 0, url: country });
      fire('history', { tabId: 5, frameId: 0, url: country });
    }
    await settle();
    expect(updates).toHaveLength(2);
    expect(updates.every((u) => u[0] === 5)).toBe(true);
  });
});

describe('blocked-navigation detection per browser', () => {
  it('Chrome needs ERR_BLOCKED_BY_CLIENT; Firefox accepts any error on the country page', () => {
    expect(chromeBlocked('net::ERR_BLOCKED_BY_CLIENT')).toBe(true);
    expect(chromeBlocked('net::ERR_NAME_NOT_RESOLVED')).toBe(false);
    expect(firefoxBlocked('NS_ERROR_ABORT')).toBe(true);
  });
});

describe('manifests', () => {
  const read = (t: string) => JSON.parse(readFileSync(`manifests/manifest.${t}.json`, 'utf8'));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  it('match package.json and each other', () => {
    for (const t of ['chrome', 'firefox']) expect(read(t).version).toBe(pkg.version);
    expect(read('firefox').permissions).toEqual(read('chrome').permissions);
    expect(read('firefox').host_permissions).toEqual(read('chrome').host_permissions);
  });
  it('declare no static Flow script and only Flow hosts', () => {
    for (const t of ['chrome', 'firefox']) {
      const m = read(t);
      expect(m.content_scripts).toBeUndefined();
      expect(m.host_permissions).not.toContain('<all_urls>');
      for (const p of m.host_permissions)
        expect(p).toMatch(/^https:\/\/(flow\.google\.com|labs\.google)\//);
    }
    expect(read('firefox').browser_specific_settings.gecko.id).toBe(
      'noleaker-flow@lordversa.github.io',
    );
  });
  it('every icon exists', () => {
    const m = read('chrome');
    for (const f of [
      ...Object.values(m.icons),
      ...Object.values(m.action.default_icon),
    ] as string[])
      expect(existsSync(`public/${f}`), f).toBe(true);
  });
});

describe.skipIf(
  !existsSync('dist/chrome/background.js') || !existsSync('dist/firefox/background.js'),
)('bundles', () => {
  it('each target carries only its own platform code', () => {
    expect(readFileSync('dist/chrome/background.js', 'utf8')).toContain('ERR_BLOCKED_BY_CLIENT');
    expect(readFileSync('dist/firefox/background.js', 'utf8')).not.toContain(
      'ERR_BLOCKED_BY_CLIENT',
    );
    expect(readFileSync('dist/firefox/manifest.json', 'utf8')).toContain('"scripts"');
  });
  it('both targets ship the page script and the popup', () => {
    for (const t of ['chrome', 'firefox'])
      for (const f of ['content/flow.js', 'popup.js', 'popup/index.html'])
        expect(existsSync(`dist/${t}/${f}`), `${t}/${f}`).toBe(true);
  });
});
