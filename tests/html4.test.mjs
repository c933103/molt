import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1];
test('HTML 4.0 markup has valid controls and labels and no CSS or HTML5 attributes', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('../check_html4.py',import.meta.url))], {encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.doesNotMatch(html, /<form\b/); // Password fields cannot fall back to native HTTP submission.
});
test('startup displays sanitized storage and crypto diagnostics without connecting or requesting', async t => {
  for (const missingCrypto of [false,true]) await t.test(missingCrypto ? 'Web Crypto unavailable' : 'IndexedDB blocked',async () => {
    const elements = new Map(); let requests = 0;
    class Element {
      constructor(tag,id='') { this.tagName=tag.toUpperCase(); this.id=id; this.value=''; this.disabled=false; this.textContent=''; }
      addEventListener() {}
    }
    for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2],new Element(match[1],match[2]));
    const document = {
      getElementById:id => elements.get(id),
      querySelectorAll:() => [...elements.values()].filter(e => e.tagName==='BUTTON'),
      get cookie() { return ''; }
    };
    const window = {addEventListener() {}};
    const marker = 'synthetic_exception_content_never_show';
    const context = {
      document,window,URL,URLSearchParams,AbortController,TextDecoder,TextEncoder,Uint8Array,Blob,
      crypto:missingCrypto ? {} : webcrypto,
      indexedDB:{open() { throw new Error(marker); }},
      location:{href:'https://c933103.github.io/molt/'},sessionStorage:{getItem() { return null; }},
      btoa,atob,setTimeout,clearTimeout,
      fetch() { requests++; throw new Error('Unexpected network request'); }
    };
    vm.runInNewContext(script,context);
    const result = await window.moltbookDesk.execute('connection');
    assert.equal(result.data.connected,false); assert.equal(requests,0);
    assert.equal(elements.get('connection').textContent,'Not connected');
    const message = elements.get('status').textContent;
    assert.match(message,missingCrypto ? /Web Crypto is unavailable/ : /Browser credential storage is unavailable/);
    assert.match(message,/Saved connection status could not be checked/);
    assert.equal(message.includes(marker),false);
    assert.equal(elements.get('connect-button').disabled,false);
  });
});

const KEY = 'moltbook_html4_fixture_not_a_real_key';
function pageFixture(options = {}) {
  const elements = new Map(), calls = [], downloads = [], links = [], revoked = [], removed = [];
  class Element {
    constructor(tag,id = '') { this.tagName=tag.toUpperCase(); this.id=id; this.value=''; this.disabled=false; this.textContent=''; this.events={}; this.children=[]; }
    addEventListener(type,handler) { this.events[type]=handler; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children=children; }
    scrollIntoView() {}
    focus() {}
    click() { options.beforeClick?.(); links.push({href:this.href,name:this.download}); }
    remove() { removed.push(this); }
  }
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2],new Element(match[1],match[2]));
  const document = {
    body:new Element('body'),
    getElementById:id => { assert.ok(elements.has(id),'Missing control: ' + id); return elements.get(id); },
    querySelectorAll:selector => { assert.equal(selector,'button'); return [...elements.values()].filter(e => e.tagName==='BUTTON'); },
    createElement:tag => { assert.ok(['button','p','h3','div','pre','br','a'].includes(tag)); return new Element(tag); },
    createTextNode:text => ({textContent:text})
  };
  const events = {}, window = {addEventListener(type,handler) { events[type]=handler; }};
  if (options.storage) Object.defineProperty(document,'cookie',Object.getOwnPropertyDescriptor(options.storage.document,'cookie'));
  class BrowserURL extends URL {
    static createObjectURL(blob) { options.beforeObjectURL?.(); downloads.push(blob); return 'blob:https://c933103.github.io/synthetic-' + downloads.length; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const context = {document,window,URL:BrowserURL,URLSearchParams,AbortController,TextDecoder,TextEncoder,Uint8Array,Blob,crypto:options.crypto || webcrypto,btoa,atob,setTimeout,clearTimeout,
    ...(options.storage ? {indexedDB:options.storage.indexedDB,sessionStorage:options.storage.sessionStorage,location:{href:'https://c933103.github.io/molt/'}} : {})};
  const fixtureOptions = options;
  context.fetch = async (url,options) => {
    calls.push({url,options});
    if (fixtureOptions.fetch) return fixtureOptions.fetch(url,options);
    return new Response(JSON.stringify(url.includes('/search?') ? {success:true,results:[]} : {success:true,agent:{name:'Fixture'}}),{headers:{'content-type':'application/json'}});
  };
  vm.runInNewContext(script,context);
  return {elements,calls,downloads,links,revoked,removed,window,events,async connect(key = KEY) {
    elements.get('api-key').value=key; await elements.get('connect-button').events.click();
  }};
}

test('native controls connect, download and restore an external ZIP, and share the connection with the CLI', async () => {
  const {elements,calls,downloads,links,revoked,window} = pageFixture();
  elements.get('api-key').value=KEY;
  await elements.get('connect-button').events.click();
  assert.equal(elements.get('api-key').value,'');
  assert.equal(downloads.length,1,'Explicit Connect requests a recovery download even without browser storage');
  assert.match(elements.get('status').textContent,/Connected for this tab only/);
  assert.match(elements.get('recovery-status').textContent,/download requested/);
  assert.match(elements.get('recovery-status').textContent,/cannot confirm/);
  assert.equal(calls[0].url,'https://www.moltbook.com/api/v1/agents/me');
  assert.equal(calls[0].options.headers.Authorization,'Bearer ' + KEY);
  assert.equal((await window.moltbookDesk.execute('connection')).data.connected,true,elements.get('status').textContent);
  elements.get('query').value='railway information';
  await elements.get('search-button').events.click();
  assert.equal(calls.length,2,elements.get('status').textContent);
  assert.equal(new URL(calls[1].url).searchParams.get('q'),'railway information');
  const result = await window.moltbookDesk.execute('me');
  assert.equal(result.ok,true); assert.equal(calls[2].options.headers.Authorization,'Bearer ' + KEY);
  assert.equal(JSON.stringify(result).includes(KEY),false);
  assert.equal(Object.hasOwn(window.moltbookDesk,'key'),false);
  elements.get('delete-post-id').value='post-123';
  elements.get('delete-confirm-id').value='wrong-post';
  await elements.get('delete-button').events.click();
  assert.equal(calls.length,3); assert.match(elements.get('status').textContent,/same post ID twice/);
  assert.equal(elements.get('delete-form').events.keydown,undefined);
  elements.get('delete-confirm-id').value='post-123';
  await elements.get('delete-button').events.click();
  assert.equal(calls.length,4); assert.equal(calls[3].options.method,'DELETE');
  assert.equal(calls[3].url,'https://www.moltbook.com/api/v1/posts/post-123');
  assert.equal(elements.get('delete-post-id').value,''); assert.equal(elements.get('delete-confirm-id').value,'');
  await elements.get('delete-button').events.click();
  assert.equal(calls.length,4); assert.equal((await window.moltbookDesk.execute('connection')).data.connected,true);
  assert.equal(elements.get('recovery-download').disabled,false);
  await elements.get('recovery-download').events.click();
  assert.equal(downloads.length,2); assert.equal(downloads[0].type,'application/zip');
  assert.deepEqual(links,[1,2].map(n => ({href:'blob:https://c933103.github.io/synthetic-' + n,name:'moltbook-recovery.zip'})));
  assert.equal(calls.length,4,'Export must not send a network request');
  assert.equal(elements.get('status').textContent.includes(KEY),false);
  const cliExport = await window.moltbookDesk.execute('recoveryArchive');
  assert.equal(cliExport.ok,false); assert.match(cliExport.error,/not supported/); assert.equal(calls.length,4);
  await elements.get('disconnect').events.click();
  assert.equal((await window.moltbookDesk.execute('connection')).data.connected,false);
  assert.equal(elements.get('recovery-download').disabled,true);
  assert.deepEqual(revoked,[1,2].map(n => 'blob:https://c933103.github.io/synthetic-' + n));
  // This context has no IndexedDB or saved browser credentials. Only the file remains.
  elements.get('recovery-file').files=[downloads[0]];
  await elements.get('recovery-import').events.click();
  assert.equal(calls.length,5); assert.equal(calls[4].options.headers.Authorization,'Bearer ' + KEY);
  assert.equal((await window.moltbookDesk.execute('connection')).data.connected,true);
  assert.equal(elements.get('recovery-file').value,'');
  assert.equal(downloads.length,2,'Import uses an existing recovery file without downloading another');
  const bad = new Uint8Array(await downloads[0].arrayBuffer()); bad[30] ^= 255;
  elements.get('recovery-file').files=[new Blob([bad],{type:'application/zip'})];
  await elements.get('recovery-import').events.click();
  assert.equal(calls.length,5); assert.match(elements.get('status').textContent,/not a valid recovery ZIP/);
  let oversizedRead = false;
  elements.get('recovery-file').files=[{size:10000,arrayBuffer() { oversizedRead=true; }}];
  await elements.get('recovery-import').events.click();
  assert.equal(oversizedRead,false); assert.equal(calls.length,5);
  let finishRead;
  elements.get('recovery-file').files=[{size:downloads[0].size,arrayBuffer() { return new Promise(resolve => { finishRead=resolve; }); }}];
  const importing = elements.get('recovery-import').events.click();
  await elements.get('disconnect').events.click();
  finishRead(await downloads[0].arrayBuffer()); await importing;
  assert.equal(calls.length,5,'An import cancelled by Disconnect cannot authenticate');
  assert.equal((await window.moltbookDesk.execute('connection')).data.connected,false);
});

// Synthetic storage shared across page instances; real Web Crypto still seals the ZIP.
function savedStorage() {
  const records = new Map(), tab = new Map(); let cookie = '';
  const db = {
    objectStoreNames:{contains:() => true}, close() {},
    transaction() {
      let pending = 0;
      const tx = {};
      const finish = () => setImmediate(() => { if (!pending) tx.oncomplete?.(); });
      const request = work => {
        pending++; const req = {};
        setImmediate(() => { req.result = work(); req.onsuccess?.(); pending--; finish(); });
        return req;
      };
      tx.objectStore = () => ({
        get:id => request(() => records.get(id)),
        put:(value,id) => request(() => records.set(id,value)),
        delete:id => request(() => records.delete(id))
      });
      finish(); return tx;
    }
  };
  return {
    document:{get cookie() { return cookie; },set cookie(value) { cookie = value.includes('Max-Age=0;') ? '' : value.split(';')[0]; }},
    indexedDB:{open() { const req = {}; setImmediate(() => { req.result = db; req.onsuccess?.(); }); return req; }},
    sessionStorage:{getItem:id => tab.get(id) ?? null,setItem:(id,value) => tab.set(id,value),removeItem:id => tab.delete(id)}
  };
}

test('explicit Connect downloads once; startup and back/forward restoration never download', async () => {
  const storage = savedStorage(), first = pageFixture({storage});
  await first.window.moltbookDesk.execute('connection');
  await first.connect();
  assert.equal(first.downloads.length,1); assert.equal(first.links.length,1);
  assert.match(first.elements.get('status').textContent,/This browser restores automatically/);
  first.events.pageshow(); await first.window.moltbookDesk.execute('connection');
  assert.equal(first.downloads.length,1);
  const restored = pageFixture({storage});
  assert.equal((await restored.window.moltbookDesk.execute('connection')).data.connected,true);
  assert.equal(restored.calls.length,0); assert.equal(restored.downloads.length,0);
  restored.events.pagehide(); restored.events.pageshow();
  assert.equal((await restored.window.moltbookDesk.execute('connection')).data.connected,true);
  assert.equal(restored.downloads.length,0); assert.equal(restored.calls.length,0);
  await restored.connect();
  assert.equal(restored.downloads.length,1,'A later explicit Connect requests a new backup');
});

test('failed or invalid Connect never exports a recovery file', async () => {
  const f = pageFixture({fetch:async () => new Response(JSON.stringify({error:'Invalid credential'}),{status:401,headers:{'content-type':'application/json'}})});
  await f.connect('invalid'); assert.equal(f.calls.length,0);
  await f.connect(); assert.equal(f.calls.length,1);
  assert.equal(f.downloads.length,0); assert.equal(f.links.length,0);
  assert.equal((await f.window.moltbookDesk.execute('connection')).data.connected,false);
  assert.equal(f.elements.get('recovery-download').disabled,true);
});

test('export failures preserve connection and a visible manual retry after other API requests', async t => {
  for (const stage of ['beforeObjectURL','beforeClick']) await t.test(stage,async () => {
    let fail = true;
    const f = pageFixture({[stage]() { if (fail) throw new Error(KEY); }});
    await f.connect();
    assert.equal((await f.window.moltbookDesk.execute('connection')).data.connected,true);
    assert.equal(f.elements.get('recovery-download').disabled,false);
    assert.equal(f.elements.get('recovery-download').textContent,'Retry recovery ZIP download');
    assert.match(f.elements.get('recovery-status').textContent,/could not be requested/);
    assert.equal(f.elements.get('recovery-status').textContent.includes(KEY),false);
    assert.equal(f.links.length,0);
    if (stage === 'beforeClick') { assert.equal(f.revoked.length,1); assert.equal(f.removed.length,1); }
    await f.window.moltbookDesk.execute('me');
    assert.match(f.elements.get('recovery-status').textContent,/Retry recovery ZIP download/);
    f.events.pageshow(); await f.window.moltbookDesk.execute('connection');
    assert.equal(f.links.length,0,'A failed automatic download must not loop on pageshow');
    fail = false;
    await f.elements.get('recovery-download').events.click();
    assert.equal(f.links.length,1); assert.equal(f.calls.length,2,'Retry exports locally without reauthenticating');
    assert.match(f.elements.get('recovery-status').textContent,/download requested/);
    assert.match(f.elements.get('recovery-status').textContent,/cannot confirm/);
  });
});

test('repeated Connect clicks share one authentication and one automatic download', async () => {
  let finish;
  const f = pageFixture({fetch:() => new Promise(resolve => { finish=resolve; })});
  const connecting = f.connect();
  await f.connect();
  assert.equal(f.calls.length,1); assert.equal(f.downloads.length,0);
  finish(new Response('{"success":true}',{headers:{'content-type':'application/json'}}));
  await connecting;
  assert.equal(f.downloads.length,1); assert.equal(f.links.length,1);
});

test('Disconnect and pagehide cancel automatic export during pending authentication', async t => {
  for (const event of ['disconnect','pagehide']) await t.test(event,async () => {
    let finish;
    const f = pageFixture({fetch:() => new Promise(resolve => { finish=resolve; })});
    const connecting = f.connect();
    if (event === 'disconnect') await f.elements.get('disconnect').events.click(); else f.events.pagehide();
    finish(new Response('{"success":true}',{headers:{'content-type':'application/json'}}));
    await connecting;
    assert.equal(f.downloads.length,0); assert.equal(f.links.length,0);
    assert.equal((await f.window.moltbookDesk.execute('connection')).data.connected,false);
  });
});

test('Disconnect while saving the connection prevents the later automatic download', async () => {
  let finish, began;
  const saving = new Promise(resolve => { began=resolve; });
  const crypto = {getRandomValues:array => webcrypto.getRandomValues(array),subtle:{
    generateKey(...args) { began(); return new Promise(resolve => { finish=() => resolve(webcrypto.subtle.generateKey(...args)); }); }
  }};
  const f = pageFixture({storage:savedStorage(),crypto});
  await f.window.moltbookDesk.execute('connection');
  const connecting = f.connect(); await saving;
  const disconnecting = f.elements.get('disconnect').events.click();
  finish(); await Promise.all([connecting,disconnecting]);
  assert.equal(f.downloads.length,0); assert.equal(f.links.length,0);
  assert.equal((await f.window.moltbookDesk.execute('connection')).data.connected,false);
});

