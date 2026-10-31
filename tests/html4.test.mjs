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
  const cases = [
    ['IndexedDB open blocked', 'indexedDB', 'blocked'],
    ['IndexedDB global absent', 'indexedDB', 'absent'],
    ['IndexedDB global null', 'indexedDB', 'null'],
    ['IndexedDB global getter throws', 'indexedDB', 'throws'],
    ['Web Crypto unavailable', 'crypto', 'blocked'],
    ['Web Crypto global absent', 'crypto', 'absent'],
    ['Web Crypto global null', 'crypto', 'null'],
    ['Web Crypto global getter throws', 'crypto', 'throws']
  ];
  for (const [name, capability, mode] of cases) await t.test(name,async () => {
    const elements = new Map(); let requests = 0, storageAccesses = 0;
    class Element {
      constructor(tag,id='') { this.tagName=tag.toUpperCase(); this.id=id; this.value=''; this.disabled=false; this.textContent=''; }
      addEventListener() {}
    }
    for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2],new Element(match[1],match[2]));
    const document = {
      getElementById:id => elements.get(id),
      querySelectorAll:() => [...elements.values()].filter(e => e.tagName==='BUTTON'),
      get cookie() { storageAccesses++; return ''; },
      set cookie(_) { storageAccesses++; }
    };
    const window = {addEventListener() {}};
    const marker = 'synthetic_exception_content_never_show';
    const context = {
      document,window,URL,URLSearchParams,AbortController,TextDecoder,TextEncoder,Uint8Array,Blob,
      crypto:capability === 'crypto' ? {} : webcrypto,
      indexedDB:{open() { throw new Error(marker); }},
      location:{href:'https://c933103.github.io/molt/'},sessionStorage:{getItem() { storageAccesses++; return null; },setItem() { storageAccesses++; },removeItem() { storageAccesses++; }},
      btoa,atob,setTimeout,clearTimeout,
      fetch() { requests++; throw new Error('Unexpected network request'); }
    };
    if (mode === 'absent') delete context[capability];
    if (mode === 'null') context[capability] = null;
    if (mode === 'throws') Object.defineProperty(context,capability,{get() { throw new Error(marker); }});
    vm.runInNewContext(script,context);
    const result = await window.moltbookDesk.execute('connection');
    assert.equal(result.data.connected,false); assert.equal(requests,0);
    assert.equal(elements.get('connection').textContent,'Not connected');
    const message = elements.get('status').textContent;
    assert.match(message,capability === 'crypto' ? /Web Crypto is unavailable/ : /Browser credential storage is unavailable/);
    assert.match(message,/Saved connection status could not be checked/);
    assert.match(message,/saved copies were not removed/i);
    assert.equal(message.includes(marker),false);
    assert.equal(storageAccesses,0);
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
  assert.deepEqual(links,[1,2].map(n => ({href:'blob:https://c933103.github.io/synthetic-' + n,name:'moltbook-pw123.zip'})));
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

test('new-key Connect downloads once; current-key Connect and browser restoration never download', async () => {
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
  assert.equal(restored.downloads.length,0,'Connecting with the restored current key does not download again');
  await restored.connect(KEY + '_rotated');
  assert.equal(restored.downloads.length,1,'A new key requests a new backup');
  assert.equal(restored.links[0].name,'moltbook-pw123.zip');
});

test('only new keys trigger automatic backups and every download suggests the fixed filename', async () => {
  const f = pageFixture();
  await f.connect();
  assert.equal(f.links.length,1);
  await f.connect('  ' + KEY + '  ');
  assert.equal(f.links.length,1,'Reauthenticating the current key must not repeat the download');
  await f.connect(KEY + '_rotated');
  assert.equal(f.links.length,2,'A different successfully authenticated key needs a new recovery file');
  await f.elements.get('recovery-download').events.click();
  assert.equal(f.links.length,3,'Manual export can request another copy');
  assert.deepEqual(f.links.map(link=>link.name),Array(3).fill('moltbook-pw123.zip'));
  await f.elements.get('disconnect').events.click();
  await f.connect(KEY + '_rotated');
  assert.equal(f.links.length,4,'A forgotten key is a new connection; the browser resolves existing filenames');
});

test('failed or invalid Connect never exports a recovery file', async () => {
  const f = pageFixture({fetch:async () => new Response(JSON.stringify({error:'Invalid credential'}),{status:401,headers:{'content-type':'application/json'}})});
  await f.connect('invalid'); assert.equal(f.calls.length,0);
  await f.connect(); assert.equal(f.calls.length,1);
  assert.equal(f.downloads.length,0); assert.equal(f.links.length,0);
  assert.equal((await f.window.moltbookDesk.execute('connection')).data.connected,false);
  assert.equal(f.elements.get('recovery-download').disabled,true);
});

test('a rejected key rotation does not turn the original saved key into a new backup', async () => {
  const rejected = KEY + '_rejected';
  const f = pageFixture({storage:savedStorage(),fetch:async (_,options) =>
    options.headers.Authorization === 'Bearer ' + rejected
      ? jsonResponse({error:'Fixture rejection'},401)
      : jsonResponse({success:true,agent:{name:'Fixture'}})});
  await f.window.moltbookDesk.execute('connection');
  await f.connect(); assert.equal(f.links.length,1);
  await f.connect(rejected);
  assert.equal((await f.window.moltbookDesk.execute('connection')).data.connected,false);
  assert.equal(f.links.length,1);
  await f.connect();
  assert.equal((await f.window.moltbookDesk.execute('connection')).data.connected,true);
  assert.equal(f.links.length,1,'The original saved key already had its automatic backup');
  await f.connect(KEY + '_rotated');
  assert.equal(f.links.length,2,'A genuinely different authenticated key still downloads');
});

test('Disconnect cancels Connect while it checks the previously saved key', async () => {
  const storage = savedStorage(), rejected = KEY + '_rejected';
  const f = pageFixture({storage,fetch:async (_,options) =>
    options.headers.Authorization === 'Bearer ' + rejected
      ? jsonResponse({error:'Fixture rejection'},401)
      : jsonResponse({success:true,agent:{name:'Fixture'}})});
  await f.window.moltbookDesk.execute('connection');
  await f.connect(); await f.connect(rejected);
  const requestsBefore = f.calls.length, downloadsBefore = f.links.length;
  const open = storage.indexedDB.open;
  let resume, began;
  const reading = new Promise(resolve => { began=resolve; });
  storage.indexedDB.open = () => {
    const req = {};
    resume = () => {
      const actual = open();
      actual.onsuccess = () => { req.result=actual.result; req.onsuccess?.(); };
    };
    began(); return req;
  };
  const connecting = f.connect(); await reading;
  const disconnecting = f.elements.get('disconnect').events.click();
  storage.indexedDB.open = open; resume();
  await Promise.all([connecting,disconnecting]);
  assert.equal(f.calls.length,requestsBefore,'Cancelled Connect must not authenticate after the storage read');
  assert.equal(f.links.length,downloadsBefore);
  assert.equal((await f.window.moltbookDesk.execute('connection')).data.connected,false);
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



function readRaw(fixture) {
  if (fixture.elements.get('raw-toggle').textContent === 'Show raw response') fixture.elements.get('raw-toggle').events.click();
  return JSON.parse(fixture.elements.get('raw-response').textContent);
}

test('vote buttons retain the exact sanitized outcome without replacing the post or pagination', async () => {
  for (const action of ['upvote', 'downvote']) for (const outcome of ['added', 'removed', 'unchanged']) {
    let finish;
    const post = {id:'receipt-post',title:'Receipt fixture',content:'Public text',upvotes:4};
    const fixture = pageFixture({fetch:async (url) => {
      if (url.endsWith('/' + action)) return new Promise(resolve => { finish=resolve; });
      return new Response(JSON.stringify(url.includes('/posts?')
        ? {success:true,posts:[post],has_more:true,next_cursor:'fixture-next'}
        : {success:true,agent:{name:'Fixture'}}),{headers:{'content-type':'application/json'}});
    }});
    await fixture.connect();
    await fixture.window.moltbookDesk.execute('posts',{sort:'new'});
    const before = fixture.elements.get('results').children.slice();
    const walk = elements => elements.flatMap(element => [element,...walk(element.children || [])]);
    const control = walk(before).find(element => element.tagName==='BUTTON' && element.textContent===(action==='upvote'?'Upvote':'Downvote'));
    assert.ok(control);
    const countBefore = fixture.calls.length;
    const pending = control.events.click();
    assert.deepEqual(readRaw(fixture),{action,post_id:post.id,state:'pending'});
    finish(new Response(JSON.stringify({success:true,action:outcome,message:'Server result '+outcome,echo:KEY,secret:'synthetic-secret'}),{headers:{'content-type':'application/json'}}));
    await pending;
    const receipt = readRaw(fixture);
    assert.equal(receipt.action,action); assert.equal(receipt.post_id,post.id);
    assert.equal(receipt.state,'response_received'); assert.equal(receipt.response.action,outcome);
    assert.equal(receipt.response.message,'Server result '+outcome);
    assert.equal(receipt.response.echo,'[credential removed]'); assert.equal(receipt.response.secret,'[credential removed]');
    assert.equal(fixture.elements.get('raw-response').textContent.includes(KEY),false);
    assert.deepEqual(fixture.elements.get('results').children,before);
    assert.equal(fixture.elements.get('next-page').disabled,false);
    assert.equal(fixture.calls.length,countBefore+1,'Exactly one vote request, with no automatic retry');
  }
});

test('failed and uncertain votes replace the prior receipt honestly and never retry', async () => {
  for (const failure of ['rejected','network','malformed']) {
    const fixture = pageFixture({fetch:async (url) => {
      if (url.endsWith('/upvote')) {
        if (failure==='network') throw Error('Synthetic transport failure');
        if (failure==='malformed') return new Response('{',{headers:{'content-type':'application/json'}});
        return new Response(JSON.stringify({success:false,error:'Fixture rejection '+KEY}),{status:400,headers:{'content-type':'application/json'}});
      }
      return new Response(JSON.stringify(url.includes('/posts?')
        ? {success:true,posts:[{id:'receipt-post',title:'Fixture',content:'Public'}]}
        : {success:true,agent:{name:'Fixture'}}),{headers:{'content-type':'application/json'}});
    }});
    await fixture.connect(); await fixture.window.moltbookDesk.execute('posts',{sort:'new'});
    const before = fixture.elements.get('results').children.slice();
    const walk = elements => elements.flatMap(element => [element,...walk(element.children || [])]);
    const control = walk(before).find(element => element.tagName==='BUTTON' && element.textContent==='Upvote');
    const calls = fixture.calls.length; await control.events.click();
    const receipt=readRaw(fixture);
    assert.equal(receipt.action,'upvote'); assert.equal(receipt.post_id,'receipt-post');
    assert.equal(receipt.state,failure==='rejected'?'request_failed':'unknown_outcome');
    assert.equal('response' in receipt,false); assert.equal(receipt.error.includes(KEY),false);
    if (failure!=='rejected') assert.match(receipt.error,/before retrying|before repeating/);
    assert.deepEqual(fixture.elements.get('results').children,before);
    assert.equal(fixture.calls.length,calls+1);
  }
});

test('repeated vote clicks do not dispatch twice and disconnect cannot expose a late response', async () => {
  let finish;
  const fixture = pageFixture({fetch:async (url) => {
    if (url.endsWith('/upvote')) return new Promise(resolve => { finish=resolve; });
    return new Response(JSON.stringify(url.includes('/posts?')
      ? {success:true,posts:[{id:'receipt-post',title:'Fixture',content:'Public'}]}
      : {success:true,agent:{name:'Fixture'}}),{headers:{'content-type':'application/json'}});
  }});
  await fixture.connect(); await fixture.window.moltbookDesk.execute('posts',{sort:'new'});
  const walk = elements => elements.flatMap(element => [element,...walk(element.children || [])]);
  const control = walk(fixture.elements.get('results').children).find(element => element.tagName==='BUTTON' && element.textContent==='Upvote');
  const calls=fixture.calls.length;
  const first=control.events.click();
  await control.events.click();
  assert.equal(fixture.calls.length,calls+1);
  assert.equal(readRaw(fixture).state,'pending');
  await fixture.elements.get('disconnect').events.click();
  finish(new Response(JSON.stringify({success:true,action:'added',secret:KEY,message:'late-response-marker'}),{headers:{'content-type':'application/json'}}));
  await first;
  const receipt=readRaw(fixture);
  assert.equal(receipt.state,'unknown_outcome'); assert.equal('response' in receipt,false);
  assert.doesNotMatch(fixture.elements.get('raw-response').textContent,/late-response-marker/);
  assert.equal(fixture.elements.get('raw-response').textContent.includes(KEY),false);
  assert.match(fixture.elements.get('connection').textContent,/Not connected/);
  assert.equal(fixture.elements.get('results').children[0].textContent,'Disconnected.');
  assert.equal(fixture.calls.length,calls+1);
});


function descendants(elements) { return elements.flatMap(element=>[element,...descendants(element.children || [])]); }
function jsonResponse(data,status=200) { return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}}); }
function findControl(f,label) { return descendants(f.elements.get('results').children).find(el=>el.tagName==='BUTTON' && el.textContent===label); }

test('comment cards vote on top-level, nested and search comment IDs, not their parent post', async () => {
  for (const source of ['comments','nested','search','search-without-parent']) {
    const comment={id:'reply-123',content:'Public fixture comment',upvotes:1};
    const fixture=pageFixture({fetch:async url=> {
      if (url.endsWith('/upvote')) return jsonResponse({success:true,action:'added'});
      if (url.includes('/search?')) return jsonResponse({results:[{...comment,type:'comment',...(source==='search' ? {post:{id:'parent-456'}} : {})}]});
      if (url.includes('/comments?')) return jsonResponse({comments:source==='nested' ? [{id:'root-111',content:'Root',replies:[comment]}] : [comment]});
      return jsonResponse({success:true,agent:{id:'agent-123'}});
    }});
    await fixture.connect();
    await fixture.window.moltbookDesk.execute(source.startsWith('search')?'search':'comments',source.startsWith('search')?{q:'fixture'}:{id:'parent-456'});
    const controls=descendants(fixture.elements.get('results').children).filter(el=>el.tagName==='BUTTON' && el.textContent==='Upvote comment once');
    assert.equal(controls.length,source==='nested'?2:1);
    assert.equal(findControl(fixture,'Downvote'),undefined);
    const before=fixture.elements.get('results').children.slice();
    await controls.at(-1).events.click();
    const last=fixture.calls.at(-1); assert.equal(last.url,'https://www.moltbook.com/api/v1/comments/reply-123/upvote');
    assert.equal(last.options.method,'POST'); assert.equal(last.options.body,undefined);
    const receipt=readRaw(fixture);
    assert.equal(receipt.type,'comment_vote'); assert.equal(receipt.comment_id,'reply-123'); assert.equal(receipt.post_id,source==='search-without-parent'?undefined:'parent-456');
    assert.deepEqual(fixture.elements.get('results').children,before);
    if (source==='search-without-parent') assert.equal(findControl(fixture,'Open post'),undefined,'Do not treat a comment ID as an unknown parent ID');
  }
});

test('deleted, unavailable and malformed comment cards have no vote or reply action', async () => {
  for (const fields of [{content:null},{content:''},{content:'[deleted]'},{content:'[removed]'},{deleted:true},{is_deleted:true},{deleted_at:'2026-10-20'},{id:'../bad'}]) {
    const fixture=pageFixture({fetch:async url=>jsonResponse(url.includes('/comments?')?{comments:[{id:'reply',content:'Original',...fields}]}:{agent:{id:'agent-123'}})});
    await fixture.connect(); await fixture.window.moltbookDesk.execute('comments',{id:'parent'});
    assert.equal(findControl(fixture,'Upvote comment once'),undefined,JSON.stringify(fields));
    assert.equal(findControl(fixture,'Reply'),undefined,JSON.stringify(fields));
  }
});

test('comment receipts preserve exact sanitized responses, the surrounding view and pagination', async () => {
  for (const outcome of ['added','removed','unchanged',null]) {
    let finish;
    const fixture=pageFixture({fetch:async url=>{
      if(url.endsWith('/upvote')) return new Promise(resolve=>{finish=resolve;});
      return jsonResponse(url.includes('/comments?')?{comments:[{id:'reply',content:'Public'}],has_more:true,next_cursor:'more'}:{agent:{id:'agent-123'}});
    }});
    await fixture.connect(); await fixture.window.moltbookDesk.execute('comments',{id:'parent'});
    const before=fixture.elements.get('results').children.slice(); const control=findControl(fixture,'Upvote comment once'); const calls=fixture.calls.length;
    const pending=control.events.click();
    assert.deepEqual(readRaw(fixture),{type:'comment_vote',action:'commentUpvote',comment_id:'reply',post_id:'parent',state:'pending'});
    await control.events.click(); assert.equal(fixture.calls.length,calls+1);
    const result={success:true,...(outcome?{action:outcome}:{}),message:'Exact server receipt',echo:KEY,api_key:'synthetic'};
    finish(jsonResponse(result)); await pending;
    const receipt=readRaw(fixture);
    assert.deepEqual(receipt.response,{...result,echo:'[credential removed]',api_key:'[credential removed]'});
    assert.equal(receipt.state,'response_received'); assert.equal('vote_state' in receipt,false,'A response is not proof of added or absent vote state');
    const saved=fixture.elements.get('raw-response').textContent;
    await control.events.click(); assert.equal(fixture.calls.length,calls+1); assert.equal(fixture.elements.get('raw-response').textContent,saved);
    assert.deepEqual(fixture.elements.get('results').children,before); assert.equal(fixture.elements.get('next-page').disabled,false);
  }
});

test('comment failures distinguish rejected from unknown and the CLI shares the UI duplicate guard', async () => {
  for (const failure of ['rejected','network','server','malformed']) {
    const fixture=pageFixture({fetch:async url=>{
      if(url.endsWith('/upvote')) {
        if(failure==='network') throw new Error('transport failure');
        if(failure==='malformed') return new Response('{',{headers:{'content-type':'application/json'}});
        return jsonResponse({success:false,error:'Fixture error '+KEY},failure==='server'?500:400);
      }
      return jsonResponse(url.includes('/comments?')?{comments:[{id:'reply',content:'Public'}]}:{agent:{id:'agent-123'}});
    }});
    await fixture.connect(); await fixture.window.moltbookDesk.execute('comments',{id:'parent'});
    const calls=fixture.calls.length; await findControl(fixture,'Upvote comment once').events.click();
    const receipt=readRaw(fixture);
    assert.equal(receipt.state,failure==='rejected'?'request_failed':'unknown_outcome'); assert.equal(receipt.error.includes(KEY),false);
    assert.equal(fixture.calls.length,calls+1);
    if(failure!=='rejected') {
      const result=await fixture.window.moltbookDesk.execute('commentUpvote',{id:'reply',post_id:'parent'});
      assert.equal(result.ok,false); assert.match(result.error,/already attempted/); assert.equal(fixture.calls.length,calls+1);
      assert.deepEqual(readRaw(fixture),receipt);
    }
  }
});

test('CLI comment vote emits the typed receipt without removing comments and prevents a later UI repeat', async () => {
  const fixture=pageFixture({fetch:async url=>jsonResponse(url.endsWith('/upvote')?{success:true,action:'unchanged',echo:KEY}:url.includes('/comments?')?{comments:[{id:'reply',content:'Public'}]}:{agent:{id:'agent-123'}})});
  await fixture.connect(); await fixture.window.moltbookDesk.execute('comments',{id:'parent'});
  const before=fixture.elements.get('results').children.slice();
  const result=await fixture.window.moltbookDesk.execute('commentUpvote',{id:'reply',post_id:'parent'});
  assert.equal(result.ok,true); assert.equal(result.data.type,'comment_vote'); assert.equal(result.data.comment_id,'reply'); assert.equal(result.data.state,'response_received');
  assert.equal(result.data.response.action,'unchanged'); assert.equal(result.data.response.echo,'[credential removed]');
  assert.deepEqual(fixture.elements.get('results').children,before);
  const calls=fixture.calls.length; await findControl(fixture,'Upvote comment once').events.click(); assert.equal(fixture.calls.length,calls);
});

test('account readback exposes raw unknown state and preserves scoped pagination', async () => {
  const fixture=pageFixture({fetch:async url=>jsonResponse(url.includes('/comments?')?{comments:[{id:'reply',content:'Public',upvotes:1,fixture_vote_field:'not interpreted'}],has_more:true,next_cursor:'next?cursor=value'}:{agent:{id:'agent-123'}})});
  await fixture.connect(); await fixture.window.moltbookDesk.execute('comments',{id:'parent'});
  await findControl(fixture,'Read account vote data').events.click();
  const read=readRaw(fixture);
  assert.equal(read.type,'comment_vote_readback'); assert.equal(read.vote_state,'unknown'); assert.equal(read.requester_id,'agent-123');
  assert.equal(read.response.comments[0].fixture_vote_field,'not interpreted');
  assert.ok(descendants(fixture.elements.get('results').children).some(el=>/state is unknown/.test(el.textContent)));
  assert.ok(findControl(fixture,'Upvote comment once'));
  const last=new URL(fixture.calls.at(-1).url); assert.equal(last.searchParams.get('requester_id'),'agent-123');
  await fixture.elements.get('next-page').events.click();
  const next=new URL(fixture.calls.at(-1).url); assert.equal(next.searchParams.get('requester_id'),'agent-123'); assert.equal(next.searchParams.get('cursor'),'next?cursor=value');
});

test('disconnect discards a late comment vote response and its guard survives reconnect', async () => {
  let finish;
  const fixture=pageFixture({fetch:async url=>{
    if(url.endsWith('/upvote')) return new Promise(resolve=>{finish=resolve;});
    return jsonResponse(url.includes('/comments?')?{comments:[{id:'reply',content:'Public'}]}:{agent:{id:'agent-123'}});
  }});
  await fixture.connect(); await fixture.window.moltbookDesk.execute('comments',{id:'parent'});
  const pending=findControl(fixture,'Upvote comment once').events.click(); const calls=fixture.calls.length;
  await fixture.elements.get('disconnect').events.click(); finish(jsonResponse({success:true,message:'late-private-response',echo:KEY})); await pending;
  const receipt=readRaw(fixture); assert.equal(receipt.state,'unknown_outcome'); assert.equal('response' in receipt,false);
  assert.doesNotMatch(fixture.elements.get('raw-response').textContent,/late-private-response/); assert.equal(fixture.calls.length,calls);
  await fixture.connect(); const before=fixture.calls.length;
  const retry=await fixture.window.moltbookDesk.execute('commentUpvote',{id:'reply'}); assert.equal(retry.ok,false); assert.equal(fixture.calls.length,before);
});


test('a null API response can be inspected and Disconnect clears it without another request', async () => {
  let requests=0;
  const fixture=pageFixture({fetch:async () => new Response(JSON.stringify(++requests===1?{agent:{id:'fixture'}}:null),{headers:{'content-type':'application/json'}})});
  await fixture.connect();
  await fixture.window.moltbookDesk.execute('me');
  fixture.elements.get('raw-toggle').events.click();
  assert.equal(fixture.elements.get('raw-response').textContent,'null');
  await fixture.elements.get('disconnect').events.click();
  assert.equal(fixture.elements.get('raw-response').textContent,'None');
  assert.equal(fixture.elements.get('raw-controls').children.length,0);
  fixture.elements.get('raw-toggle').events.click();
  assert.equal(fixture.elements.get('raw-response').textContent,'None');
  assert.equal(requests,2);
});

test('explicit removal UI has no Enter submit and shares exact guard and receipt with CLI', async () => {
  const fixture=pageFixture({fetch:async(url,opts)=>jsonResponse(opts.method==='DELETE'?{success:true,action:'removed'}:url.includes('/comments?')?{comments:[{id:'reply',user_vote:1}]}:{agent:{id:'agent'}})});
  await fixture.connect();
  assert.match(html,/Build: comment-downvote-compat-v1/);
  assert.equal(fixture.elements.get('remove-vote-panel').events.keydown,undefined);
  for(const [id,value] of [['remove-vote-id','reply'],['remove-vote-confirm-id','reply'],['remove-vote-post-id','parent']]) fixture.elements.get(id).value=value;
  await fixture.elements.get('remove-vote-button').events.click();
  const receipt=readRaw(fixture);assert.equal(receipt.action,'commentRemoveUpvote');assert.equal(receipt.comment_id,'reply');assert.equal(receipt.post_id,'parent');
  assert.equal(receipt.response.removal_verified,false);assert.equal(receipt.response.contract,'unverified_compatibility');
  const before=fixture.calls.length;
  const duplicate=await fixture.window.moltbookDesk.execute('commentRemoveUpvote',{id:'reply',post_id:'parent',confirm_id:'reply'});
  assert.equal(duplicate.ok,false);await fixture.elements.get('remove-vote-button').events.click();
  assert.equal(fixture.calls.length,before);assert.deepEqual(readRaw(fixture),receipt);
  assert.equal(fixture.calls.filter(c=>c.options.method==='DELETE').length,1);
  assert.equal(fixture.calls.at(-1).url,'https://www.moltbook.com/api/v1/comments/reply/upvote');
});

test('UI and CLI removal failure receipts retain the failed request phase without claiming removal', async () => {
  for(const via of ['ui','cli'])for(const stage of ['comments','delete']){
    const fixture=pageFixture({fetch:async(url,opts)=>{
      const here=opts.method==='DELETE'?'delete':url.includes('/comments?')?'comments':'identity';
      return here===stage?jsonResponse({error:'Not Found'},404):jsonResponse(here==='identity'?{agent:{id:'agent'}}:{comments:[{id:'reply',user_vote:1}]});
    }});
    await fixture.connect();
    const p={id:'reply',post_id:'parent',confirm_id:'reply'};let result;
    if(via==='cli')result=await fixture.window.moltbookDesk.execute('commentRemoveUpvote',p);
    else{
      for(const [id,value] of [['remove-vote-id','reply'],['remove-vote-confirm-id','reply'],['remove-vote-post-id','parent']])fixture.elements.get(id).value=value;
      await fixture.elements.get('remove-vote-button').events.click();
    }
    const receipt=readRaw(fixture);
    assert.equal(receipt.state,'request_failed');assert.equal(receipt.comment_id,'reply');
    assert.equal(receipt.removal_attempt.phase,stage==='delete'?'removal':'preflight');
    assert.equal(receipt.removal_attempt.mutation_sent,stage==='delete');
    assert.equal(receipt.removal_attempt.failed_request.http_status,404);
    assert.equal(receipt.removal_attempt.removal_verified,false);
    if(result){assert.equal(result.ok,false);assert.deepEqual(JSON.parse(JSON.stringify(result.receipt)),receipt);}
    assert.equal(fixture.calls.filter(c=>c.options.method==='DELETE').length,stage==='delete'?1:0);
  }
});

test('explicit comment downvote UI and CLI share one guarded exact-target receipt',async()=>{
  const fixture=pageFixture({fetch:async(url,opts)=>jsonResponse(opts.method==='POST'?{success:true,action:'downvoted'}:url.includes('/comments?')?{comments:[{id:'reply',user_vote:1}]}:{agent:{id:'agent'}})});
  await fixture.connect();assert.equal(fixture.elements.get('downvote-comment-panel').events.keydown,undefined);
  for(const [id,value] of [['downvote-comment-id','reply'],['downvote-comment-confirm-id','reply'],['downvote-comment-post-id','parent']])fixture.elements.get(id).value=value;
  await fixture.elements.get('downvote-comment-button').events.click();const receipt=readRaw(fixture);
  assert.equal(receipt.action,'commentDownvote');assert.equal(receipt.comment_id,'reply');assert.equal(receipt.post_id,'parent');assert.equal(receipt.response.vote_verified,false);
  const calls=fixture.calls.length;
  const repeat=await fixture.window.moltbookDesk.execute('commentDownvote',{id:'reply',post_id:'parent',confirm_id:'reply'});assert.equal(repeat.ok,false);
  await fixture.elements.get('downvote-comment-button').events.click();assert.equal(fixture.calls.length,calls);assert.deepEqual(readRaw(fixture),receipt);
  assert.equal(fixture.calls.at(-1).url,'https://www.moltbook.com/api/v1/comments/reply/downvote');assert.equal(fixture.calls.at(-1).options.method,'POST');
});
