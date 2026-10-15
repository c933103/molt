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

test('native controls connect, download and restore an external ZIP, and share the connection with the CLI', async () => {
  const elements = new Map(), calls = [], downloads = [], links = [], revoked = [], KEY = 'moltbook_html4_fixture_not_a_real_key';
  class Element {
    constructor(tag,id = '') { this.tagName=tag.toUpperCase(); this.id=id; this.value=''; this.disabled=false; this.textContent=''; this.events={}; this.children=[]; }
    addEventListener(type,handler) { this.events[type]=handler; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children=children; }
    scrollIntoView() {}
    focus() {}
    click() { links.push({href:this.href,name:this.download}); }
    remove() {}
  }
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2],new Element(match[1],match[2]));
  const document = {
    body:new Element('body'),
    getElementById:id => { assert.ok(elements.has(id),'Missing control: ' + id); return elements.get(id); },
    querySelectorAll:selector => { assert.equal(selector,'button'); return [...elements.values()].filter(e => e.tagName==='BUTTON'); },
    createElement:tag => { assert.ok(['button','p','h3','div','pre','br','a'].includes(tag)); return new Element(tag); },
    createTextNode:text => ({textContent:text})
  };
  const window = {addEventListener() {}};
  class BrowserURL extends URL {
    static createObjectURL(blob) { downloads.push(blob); return 'blob:https://c933103.github.io/synthetic-' + downloads.length; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const context = {document,window,URL:BrowserURL,URLSearchParams,AbortController,TextDecoder,TextEncoder,Uint8Array,Blob,crypto:webcrypto,btoa,atob,setTimeout,clearTimeout};
  context.fetch = async (url,options) => {
    calls.push({url,options});
    return new Response(JSON.stringify(url.includes('/search?') ? {success:true,results:[]} : {success:true,agent:{name:'Fixture'}}),{headers:{'content-type':'application/json'}});
  };
  vm.runInNewContext(script,context);
  elements.get('api-key').value=KEY;
  await elements.get('connect-button').events.click();
  assert.equal(elements.get('api-key').value,'');
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
  assert.equal(downloads.length,1); assert.equal(downloads[0].type,'application/zip');
  assert.deepEqual(links,[{href:'blob:https://c933103.github.io/synthetic-1',name:'moltbook-recovery.zip'}]);
  assert.equal(calls.length,4,'Export must not send a network request');
  assert.equal(elements.get('status').textContent.includes(KEY),false);
  const cliExport = await window.moltbookDesk.execute('recoveryArchive');
  assert.equal(cliExport.ok,false); assert.match(cliExport.error,/not supported/); assert.equal(calls.length,4);
  await elements.get('disconnect').events.click();
  assert.equal((await window.moltbookDesk.execute('connection')).data.connected,false);
  assert.equal(elements.get('recovery-download').disabled,true);
  assert.deepEqual(revoked,['blob:https://c933103.github.io/synthetic-1']);
  // This context has no IndexedDB or saved browser credentials. Only the file remains.
  elements.get('recovery-file').files=[downloads[0]];
  await elements.get('recovery-import').events.click();
  assert.equal(calls.length,5); assert.equal(calls[4].options.headers.Authorization,'Bearer ' + KEY);
  assert.equal((await window.moltbookDesk.execute('connection')).data.connected,true);
  assert.equal(elements.get('recovery-file').value,'');
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

