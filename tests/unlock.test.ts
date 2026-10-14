/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_STATUS,
  BLOCKED_STATUSES,
  CONFIG_RPC,
  patchBatchResponse,
  patchParsed,
  STATUS_RPC,
} from '../src/flow/batchexecute';
import { installFlowFreeze } from '../src/flow/freeze';
import { readVarint, rewriteVarintField, writeVarint } from '../src/flow/protobuf';
import { installFlowUnlock } from '../src/flow/unlock';
import {
  allowBounce,
  bounceTarget,
  FLOW_MATCHES,
  isFlowUrl,
  isUnsupportedCountryUrl,
  MAX_BOUNCES,
  UNSUPPORTED_ROUTE_REGEX,
} from '../src/flow/urls';

const bytes = (...n: number[]) => Uint8Array.from(n);
const text = (s: string) => Array.from(new TextEncoder().encode(s));
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const byteLength = (s: string) => new TextEncoder().encode(s).length;

// --- recorded-style samples -----------------------------------------------------------------------
// The shapes below follow what Flow's batchexecute endpoint returns. If Google changes the format,
// these samples stop matching and this file fails: that is its job.

/** A feature-flag payload as the page receives it: 40 slots, flags 31 and 32 off. */
const configArray = () => {
  const a: unknown[] = Array.from({ length: 40 }, () => null);
  a[0] = 'flow';
  a[30] = false;
  a[31] = false;
  return a;
};
/** Protobuf: field 1 = 7, field 2 = "ab", field 31 = 0 (flag off), no field 32. */
const configProto = () => bytes(0x08, 0x07, 0x12, 0x02, ...text('ab'), 0xf8, 0x01, 0x00);
/** Protobuf: field 1 = <status>, field 2 = "ab". */
const statusProto = (status: number) => bytes(0x08, status, 0x12, 0x02, ...text('ab'));

type Frame = unknown[];
const wrb = (rpc: string, payload: unknown): Frame => [
  'wrb.fr',
  rpc,
  payload,
  null,
  null,
  null,
  'generic',
];

/** Build a framed response the way the server does: length before each chunk, total at the end. */
function framed(chunks: Frame[][]): string {
  const render = (total: number): string => {
    const all = [...chunks, [['e', 4, null, null, total]]];
    return `)]}'\n\n${all
      .map((c) => {
        const json = JSON.stringify(c);
        return `${json.length}\n${json}`;
      })
      .join('\n')}`;
  };
  let total = 0;
  let out = render(total);
  for (let i = 0; i < 6 && byteLength(out) !== total; i++) {
    total = byteLength(out);
    out = render(total);
  }
  return out;
}

/** Split a framed response into [declaredLength, json] pairs. */
function chunksOf(response: string): { declared: number; json: string }[] {
  const lines = response.replace(/^\)\]\}'\n\n/, '').split('\n');
  const out: { declared: number; json: string }[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    out.push({ declared: Number(lines[i]), json: lines[i + 1] ?? '' });
  }
  return out;
}

/** The invariants of a well-formed response: each length matches its chunk, the total is exact. */
function expectWellFormed(response: string): void {
  const chunks = chunksOf(response);
  for (const c of chunks) expect(c.declared).toBe(c.json.length);
  const end = JSON.parse(chunks.at(-1)!.json);
  expect(end[0][0]).toBe('e');
  expect(end[0].at(-1)).toBe(byteLength(response));
}

const frameOf = (response: string, rpc: string): any[] =>
  chunksOf(response)
    .flatMap((c) => JSON.parse(c.json) as any[])
    .find((f) => f[0] === 'wrb.fr' && f[1] === rpc)!;

const jsonSample = () =>
  framed([
    [wrb(CONFIG_RPC, JSON.stringify(configArray()))],
    [wrb(STATUS_RPC, JSON.stringify([4, 'نه', null]))], // Persian text: bytes differ from chars
    [wrb('other1', '["keep","me"]'), ['di', 42], ['af.httprm', 41, '-1', 1]],
  ]);

const protoSample = () =>
  framed([
    [wrb(CONFIG_RPC, b64(configProto()))],
    [wrb(STATUS_RPC, b64(statusProto(8)))],
    [wrb('other1', '["keep","me"]')],
  ]);

describe('protobuf helpers', () => {
  it('reads and writes varints, including multi-byte values', () => {
    for (const n of [0, 1, 127, 128, 300, 16384, 2 ** 31, 2 ** 40]) {
      expect(readVarint(Uint8Array.from(writeVarint(n)), 0)?.value).toBe(n);
    }
    expect(writeVarint(300)).toEqual([0xac, 0x02]);
    expect(readVarint(bytes(0x80), 0)).toBeNull(); // unterminated
  });
  it('changes a matching field and keeps every other byte', () => {
    const out = rewriteVarintField(statusProto(8), 1, (v) => (v === 8 ? 1 : null), null)!;
    expect(Array.from(out)).toEqual(Array.from(statusProto(1)));
  });
  it('appends the field when it is missing, only if asked to', () => {
    const base = bytes(0x08, 0x01);
    expect(rewriteVarintField(base, 31, () => 1, null)).toBeNull();
    const out = rewriteVarintField(base, 31, () => 1, 1)!;
    expect(Array.from(out)).toEqual([0x08, 0x01, 0xf8, 0x01, 0x01]);
  });
  it('returns null when nothing changes, and for input it cannot parse', () => {
    expect(rewriteVarintField(statusProto(1), 1, () => null, null)).toBeNull();
    expect(rewriteVarintField(bytes(0x12, 0x09, 0x61), 1, () => 1, 1)).toBeNull(); // cut short
    expect(rewriteVarintField(bytes(0x0b), 1, () => 1, 1)).toBeNull(); // start-group
  });
  it('skips fixed-width and length-delimited fields without touching them', () => {
    const msg = bytes(0x09, 1, 2, 3, 4, 5, 6, 7, 8, 0x15, 1, 2, 3, 4, 0x08, 0x05);
    const out = rewriteVarintField(msg, 1, () => 1, null)!;
    expect(Array.from(out)).toEqual([...msg.subarray(0, 14), 0x08, 0x01]);
  });
});

describe('batchexecute: JSON payloads', () => {
  it('turns on flags 31 and 32 and rewrites a blocked status', () => {
    const before = jsonSample();
    const after = patchBatchResponse(before)!;
    expect(after).not.toBeNull();
    const config = JSON.parse(frameOf(after, CONFIG_RPC)[2]);
    expect(config[30]).toBe(true);
    expect(config[31]).toBe(true);
    expect(config[0]).toBe('flow');
    expect(JSON.parse(frameOf(after, STATUS_RPC)[2])[0]).toBe(ALLOWED_STATUS);
  });
  it('fixes every length prefix and the closing total (also with non-ASCII text)', () => {
    const before = jsonSample();
    expectWellFormed(before);
    const after = patchBatchResponse(before)!;
    expect(after.length).not.toBe(before.length);
    expectWellFormed(after);
    // the Persian frame really makes bytes differ from characters, so the test means something
    expect(byteLength(before)).toBeGreaterThan(before.length);
  });
  it('leaves frames it does not know exactly as they were', () => {
    const after = patchBatchResponse(jsonSample())!;
    const keep = chunksOf(after).at(-2)!.json;
    expect(keep).toBe(chunksOf(jsonSample()).at(-2)!.json);
  });
  it('rewrites every blocked status code and no other', () => {
    for (const code of BLOCKED_STATUSES) {
      const r = framed([[wrb(STATUS_RPC, JSON.stringify([code]))]]);
      expect(JSON.parse(frameOf(patchBatchResponse(r)!, STATUS_RPC)[2])[0]).toBe(1);
    }
    for (const code of [0, 1, 2, 3, 7]) {
      expect(patchBatchResponse(framed([[wrb(STATUS_RPC, JSON.stringify([code]))]]))).toBeNull();
    }
  });
  it('is idempotent: an already allowed response is not touched', () => {
    const once = patchBatchResponse(jsonSample())!;
    expect(patchBatchResponse(once)).toBeNull();
  });
  it('accepts a payload that is already a parsed array', () => {
    const r = framed([[wrb(CONFIG_RPC, configArray())]]);
    const config = frameOf(patchBatchResponse(r)!, CONFIG_RPC)[2];
    expect(config[30]).toBe(true);
    expect(config[31]).toBe(true);
  });
});

describe('batchexecute: base64 protobuf payloads', () => {
  it('sets flags 31 (changed) and 32 (added) to 1', () => {
    const after = patchBatchResponse(protoSample())!;
    const proto = fromB64(frameOf(after, CONFIG_RPC)[2]);
    expect(Array.from(proto)).toEqual([
      0x08,
      0x07,
      0x12,
      0x02,
      ...text('ab'),
      0xf8,
      0x01,
      0x01,
      0x80,
      0x02,
      0x01,
    ]);
  });
  it('rewrites the status field and keeps the rest of the message', () => {
    const after = patchBatchResponse(protoSample())!;
    expect(Array.from(fromB64(frameOf(after, STATUS_RPC)[2]))).toEqual(Array.from(statusProto(1)));
  });
  it('fixes lengths and the total', () => {
    expectWellFormed(protoSample());
    expectWellFormed(patchBatchResponse(protoSample())!);
  });
  it('reads URL-safe base64 too', () => {
    const urlSafe = b64(statusProto(5)).replace(/\+/g, '-').replace(/\//g, '_');
    const r = framed([[wrb(STATUS_RPC, urlSafe)]]);
    const after = patchBatchResponse(r)!;
    expect(Array.from(fromB64(frameOf(after, STATUS_RPC)[2]))).toEqual(Array.from(statusProto(1)));
  });
  it('leaves flags that are already on', () => {
    const on = bytes(0xf8, 0x01, 0x01, 0x80, 0x02, 0x01);
    expect(patchBatchResponse(framed([[wrb(CONFIG_RPC, b64(on))]]))).toBeNull();
  });
});

describe('batchexecute: things that must not break', () => {
  it('returns null for text that is not a response', () => {
    for (const t of ['', 'hello', '{"a":1}', ")]}'\n\n", ")]}'\n\n5\n[[1,2"]) {
      expect(patchBatchResponse(t)).toBeNull();
    }
  });
  it('returns null when no known rpc is present', () => {
    expect(patchBatchResponse(framed([[wrb('zzzzzz', '["x"]')]]))).toBeNull();
  });
  it('ignores a payload that is neither JSON nor base64', () => {
    expect(patchBatchResponse(framed([[wrb(CONFIG_RPC, '%%%not valid%%%')]]))).toBeNull();
    expect(patchBatchResponse(framed([[wrb(CONFIG_RPC, '')]]))).toBeNull();
    expect(patchBatchResponse(framed([[wrb(CONFIG_RPC, '[broken')]]))).toBeNull();
  });
  it('copes with brackets and escaped quotes inside strings', () => {
    const tricky = JSON.stringify(['a"]b', '\\"[', configArray()[0]]);
    const r = framed([[wrb('other1', tricky), wrb(STATUS_RPC, '[4]')]]);
    const after = patchBatchResponse(r)!;
    expectWellFormed(after);
    expect(JSON.parse(frameOf(after, 'other1')[2])).toEqual(['a"]b', '\\"[', 'flow']);
  });
  it('works without a closing total frame', () => {
    const body = `)]}'\n\n`;
    const json = JSON.stringify([wrb(STATUS_RPC, '[4]')]);
    const after = patchBatchResponse(`${body}${json.length}\n${json}`)!;
    const chunk = chunksOf(after)[0]!;
    expect(chunk.declared).toBe(chunk.json.length);
    expect(JSON.parse(JSON.parse(chunk.json)[0][2])[0]).toBe(1);
  });
  it('patchParsed finds frames up to three levels deep and no deeper', () => {
    const shallow = [[wrb(STATUS_RPC, '[4]')]];
    expect(patchParsed(shallow)).toMatchObject({ changed: true, seen: [STATUS_RPC] });
    const deep = [[[[wrb(STATUS_RPC, '[4]')]]]];
    expect(patchParsed(deep).changed).toBe(false);
  });
});

// --- fetch and XMLHttpRequest ------------------------------------------------------------------------

function pageRealm(responder: (url: string) => string, extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const sandbox = createContext({
    Response,
    Request,
    URL,
    TextEncoder,
    atob,
    btoa,
    ...extra,
  });
  runInContext(
    `
    globalThis.fetch = function fetch(input, init) { return globalThis.__fetch(input, init); };
    globalThis.XMLHttpRequest = class XMLHttpRequest {
      open(method, url) { this.__url = url; }
      get responseText() { return globalThis.__body(this.__url); }
      get response() { return this.__json ? JSON.parse(globalThis.__body(this.__url)) : globalThis.__body(this.__url); }
    };
  `,
    sandbox,
  );
  // The realm's own global object: what a page's `window` is.
  const ctx: any = runInContext('globalThis', sandbox);
  ctx.__fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : String(input.url ?? input.href);
    calls.push(url);
    return new Response(responder(url), { status: 200, statusText: 'OK', headers: { a: 'b' } });
  };
  ctx.__body = (url: string) => responder(url);
  return { ctx, sandbox, calls };
}

const BATCH = 'https://flow.google.com/_/Flow/data/batchexecute?rpcids=cPZSdc';

describe('Flow unlock: fetch and XMLHttpRequest', () => {
  it('rewrites batchexecute answers on fetch and keeps status and headers', async () => {
    const { ctx } = pageRealm(() => jsonSample());
    const unlock = installFlowUnlock(ctx);
    expect(unlock.patched()).toBe(false);
    const res: Response = await ctx.fetch(BATCH);
    const body = await res.text();
    expect(body).toBe(patchBatchResponse(jsonSample()));
    expect(res.status).toBe(200);
    expect(res.statusText).toBe('OK');
    expect(res.headers.get('a')).toBe('b');
    expect(unlock.patched()).toBe(true);
  });
  it('leaves other requests, and answers that need no change, alone', async () => {
    const { ctx } = pageRealm(() => jsonSample());
    const unlock = installFlowUnlock(ctx);
    expect(await (await ctx.fetch('https://flow.google.com/api/other')).text()).toBe(jsonSample());
    expect(unlock.patched()).toBe(false);
    const quiet = pageRealm(() => 'plain text');
    installFlowUnlock(quiet.ctx);
    const res: Response = await quiet.ctx.fetch(BATCH);
    expect(await res.text()).toBe('plain text');
  });
  it('accepts URL and Request arguments', async () => {
    const { ctx } = pageRealm(() => jsonSample());
    installFlowUnlock(ctx);
    const viaUrl = await (await ctx.fetch(new URL(BATCH))).text();
    const viaRequest = await (await ctx.fetch(new Request(BATCH))).text();
    expect(viaUrl).toBe(patchBatchResponse(jsonSample()));
    expect(viaRequest).toBe(patchBatchResponse(jsonSample()));
  });
  it('rewrites XMLHttpRequest text and JSON answers, only for batchexecute URLs', () => {
    const { ctx } = pageRealm(() => jsonSample());
    const unlock = installFlowUnlock(ctx);
    const xhr = new ctx.XMLHttpRequest();
    xhr.open('POST', BATCH);
    expect(xhr.responseText).toBe(patchBatchResponse(jsonSample()));
    expect(unlock.patched()).toBe(true);

    const other = new ctx.XMLHttpRequest();
    other.open('GET', 'https://flow.google.com/x');
    expect(other.responseText).toBe(jsonSample());
  });
  it('rewrites a responseType "json" answer in place', () => {
    const parsed = JSON.stringify([wrb(STATUS_RPC, '[4]')]);
    const { ctx } = pageRealm(() => parsed);
    const unlock = installFlowUnlock(ctx);
    const xhr = new ctx.XMLHttpRequest();
    xhr.__json = true;
    xhr.open('POST', BATCH);
    expect(JSON.parse(xhr.response[0][2])[0]).toBe(1);
    expect(unlock.patched()).toBe(true);
  });
  it('leaves no trace on the XMLHttpRequest object', () => {
    const { ctx } = pageRealm(() => jsonSample());
    installFlowUnlock(ctx);
    const xhr = new ctx.XMLHttpRequest();
    const before = Object.getOwnPropertyNames(xhr);
    xhr.open('POST', BATCH);
    const added = Object.getOwnPropertyNames(xhr).filter((k) => !before.includes(k));
    expect(added.every((k) => k === '__url')).toBe(true); // the fake's own field, not ours
    expect(Object.getOwnPropertySymbols(xhr)).toEqual([]);
  });
  it('the patched functions look native', () => {
    const { ctx, sandbox } = pageRealm(() => jsonSample());
    installFlowUnlock(ctx);
    const probe = runInContext(
      `(() => {
        const str = (f) => Function.prototype.toString.call(f);
        const open = XMLHttpRequest.prototype.open;
        const get = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText').get;
        return [str(fetch), fetch.name, 'prototype' in fetch, str(open), open.name,
          open.length, str(get), get.name];
      })()`,
      sandbox,
    );
    expect(probe).toEqual([
      'function fetch() { [native code] }',
      'fetch',
      false,
      'function open() { [native code] }',
      'open',
      2,
      'function get responseText() { [native code] }',
      'get responseText',
    ]);
  });
  it('never breaks the page when reading the answer fails', async () => {
    const { ctx } = pageRealm(() => jsonSample());
    ctx.__fetch = async () => ({
      clone: () => {
        throw new Error('locked');
      },
    });
    installFlowUnlock(ctx);
    const res: any = await ctx.fetch(BATCH);
    expect(typeof res.clone).toBe('function'); // the original object came back
  });
});

// --- freeze --------------------------------------------------------------------------------------------

function freezeRealm(pathname: string, buttons: string[] = []) {
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  const intervals: { fn: () => void; id: number }[] = [];
  let stops = 0;
  let observerCallback: (() => void) | null = null;
  let disconnected = false;
  const g: any = {
    location: { pathname },
    document: {
      documentElement: {},
      querySelectorAll: () =>
        buttons.map((label) => ({ textContent: label, getAttribute: () => null })),
      addEventListener: () => undefined,
    },
    MutationObserver: class {
      constructor(cb: () => void) {
        observerCallback = cb;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms, id: timers.length + 1 });
      return timers.length;
    },
    clearTimeout: (id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    setInterval: (fn: () => void) => {
      intervals.push({ fn, id: intervals.length + 1 });
      return intervals.length;
    },
    clearInterval: () => undefined,
    stop: () => void (stops += 1),
  };
  return {
    g,
    timers,
    intervals,
    stops: () => stops,
    mutate: () => observerCallback?.(),
    observing: () => observerCallback !== null,
    disconnected: () => disconnected,
    runTimers: () => [...timers].forEach((t) => t.fn()),
  };
}

describe('Flow freeze', () => {
  it('stops the page when Flow drew its main screen and nothing was rewritten', () => {
    const r = freezeRealm('/fx/tools/flow', ['New project']);
    installFlowFreeze(r.g, () => false);
    r.mutate();
    expect(r.timers).toHaveLength(30);
    expect(r.timers[0]!.ms).toBe(0);
    expect(r.timers[29]!.ms).toBe(29 * 60);
    r.runTimers();
    expect(r.stops()).toBe(30);
    expect(r.disconnected()).toBe(true);
  });
  it('does nothing when the answers were rewritten, or the screen is not drawn yet', () => {
    const patched = freezeRealm('/', ['Create']);
    installFlowFreeze(patched.g, () => true);
    patched.mutate();
    expect(patched.timers).toHaveLength(0);

    const empty = freezeRealm('/', ['Settings', 'Help']);
    installFlowFreeze(empty.g, () => false);
    empty.mutate();
    expect(empty.timers).toHaveLength(0);
  });
  it('matches the button by its aria-label too', () => {
    const r = freezeRealm('/');
    r.g.document.querySelectorAll = () => [
      { textContent: '', getAttribute: () => 'Create new project' },
    ];
    installFlowFreeze(r.g, () => false);
    r.mutate();
    expect(r.timers).toHaveLength(30);
  });
  it('never stops the country page itself, so the bounce cannot be cancelled', () => {
    const r = freezeRealm('/u/1/unsupported-country', ['Create']);
    installFlowFreeze(r.g, () => false);
    expect(r.observing()).toBe(false);
    expect(r.timers).toHaveLength(0);
    expect(r.stops()).toBe(0);
  });
  it('lets go of a running freeze when the router moves to the country page', () => {
    const r = freezeRealm('/fx/tools/flow', ['Create']);
    installFlowFreeze(r.g, () => false);
    r.mutate();
    expect(r.timers).toHaveLength(30);
    r.g.location.pathname = '/unsupported-country';
    r.intervals[0]!.fn();
    expect(r.timers).toHaveLength(0);
  });
});

// --- URLs, bounce limits, network rule -------------------------------------------------------------------

describe('Flow URLs', () => {
  it('knows Flow pages', () => {
    expect(isFlowUrl('https://flow.google.com/')).toBe(true);
    expect(isFlowUrl('https://labs.google/fx/tools/flow')).toBe(true);
    expect(isFlowUrl('https://flow.google.com.evil.com/')).toBe(false);
    expect(isFlowUrl('https://evil.com/flow.google.com/')).toBe(false);
    expect(isFlowUrl('not a url')).toBe(false);
  });
  it('knows the country page, on both hosts and with an account index', () => {
    for (const url of [
      'https://flow.google.com/unsupported-country',
      'https://flow.google.com/u/2/unsupported-country?x=1',
      'https://labs.google/fx/tools/flow/unsupported-country',
      'https://flow.google.com/UNSUPPORTED-COUNTRY',
    ]) {
      expect(isUnsupportedCountryUrl(url), url).toBe(true);
    }
    expect(isUnsupportedCountryUrl('https://flow.google.com/project/1')).toBe(false);
    expect(isUnsupportedCountryUrl('https://example.com/unsupported-country')).toBe(false);
  });
  it('bounces to the home page and keeps /u/N/', () => {
    expect(bounceTarget('https://flow.google.com/unsupported-country')).toBe(
      'https://flow.google.com/',
    );
    expect(bounceTarget('https://flow.google.com/u/3/unsupported-country')).toBe(
      'https://flow.google.com/u/3/',
    );
    expect(bounceTarget('https://labs.google/fx/tools/flow/unsupported-country')).toBe(
      'https://flow.google.com/',
    );
    expect(bounceTarget('garbage')).toBe('https://flow.google.com/');
  });
  it('allows two bounces a minute per tab, then waits', () => {
    let attempts: number[] = [];
    const step = (now: number) => {
      const v = allowBounce(attempts, now);
      attempts = v.attempts;
      return v.allowed;
    };
    expect(MAX_BOUNCES).toBe(2);
    expect([step(0), step(1000), step(2000)]).toEqual([true, true, false]);
    expect(step(59_999)).toBe(false);
    expect(step(60_001)).toBe(true); // the first attempt aged out
  });
  it('the blocking regex matches the country page and only that', () => {
    const re = new RegExp(UNSUPPORTED_ROUTE_REGEX);
    for (const url of [
      'https://flow.google.com/unsupported-country',
      'https://flow.google.com/u/0/unsupported-country',
      'https://flow.google.com/unsupported-country?from=x',
      'https://labs.google/fx/tools/flow/unsupported-country#a',
    ]) {
      expect(re.test(url), url).toBe(true);
    }
    for (const url of [
      'https://flow.google.com/',
      'https://flow.google.com/project/unsupported-country-notes',
      'https://flow.google.com/unsupported-countryx',
      'http://flow.google.com/unsupported-country',
      'https://other.google.com/unsupported-country',
    ]) {
      expect(re.test(url), url).toBe(false);
    }
  });
  it('content script matches are exactly the two Flow addresses', () => {
    expect(FLOW_MATCHES).toEqual([
      'https://flow.google.com/*',
      'https://labs.google/fx/tools/flow*',
    ]);
  });
});

// --- the built script, when a build exists -----------------------------------------------------------------------

describe.skipIf(!existsSync('dist/chrome/content/flow.js'))('built Flow script', () => {
  const source = () => readFileSync('dist/chrome/content/flow.js', 'utf8');
  it('is a self-contained classic script', () => {
    expect(source()).not.toMatch(/^\s*(import|export)\s/m);
  });
  it('rewrites a batchexecute answer when run in a page realm', async () => {
    const { ctx, sandbox } = pageRealm(() => jsonSample(), {
      document: { documentElement: null, addEventListener: () => undefined },
      location: { pathname: '/' },
      setInterval: () => 1,
      clearInterval: () => undefined,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
    });
    runInContext(source(), sandbox);
    const res: Response = await ctx.fetch(BATCH);
    expect(await res.text()).toBe(patchBatchResponse(jsonSample()));
  });
});
