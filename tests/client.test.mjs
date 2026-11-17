import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, webcrypto} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const core = html.match(/\/\/ BEGIN CLIENT\n([\s\S]*?)\/\/ END CLIENT/)[1];
const KEY = 'moltbook_test_fixture_never_a_real_key';
function setup(fetchImpl, globals = {}) {
  const context = {fetch:fetchImpl, URL, URLSearchParams, AbortController, TextDecoder, TextEncoder, Uint8Array, btoa, atob, setTimeout, clearTimeout};
  // Use an explicit global facade: Node VM contextification swallows some host getter errors.
  if (Object.getOwnPropertyNames(globals).length) context.globalThis=globals;
  vm.runInNewContext(core + '\nthis.Session = MoltbookSession; this.operation = operation; this.Vault = CredentialVault; this.Zip = CredentialZip;', context);
  const session = new context.Session(); session.connect(KEY);
  return {session, operation:context.operation, Vault:context.Vault, Zip:context.Zip};
}
function response(data = {success:true}, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json', ...headers}});
}

test('credential is attached only to the fixed Moltbook API, with no cookies or redirects', async () => {
  const calls = [];
  const {session} = setup(async (...args) => { calls.push(args); return response(); });
  await session.request('me');
  assert.equal(calls.length, 1);
  const [url, opts] = calls[0];
  assert.equal(url, 'https://www.moltbook.com/api/v1/agents/me');
  assert.equal(opts.headers.Authorization, 'Bearer ' + KEY);
  assert.equal(opts.redirect, 'error'); assert.equal(opts.credentials, 'omit'); assert.equal(opts.cache, 'no-store');
  assert.equal(opts.referrerPolicy, 'no-referrer');
  assert.equal(Object.keys(session).length, 0);
});
test('invalid operations and path traversal cannot send the credential anywhere', async () => {
  let calls = 0; const {session} = setup(async () => { calls++; return response(); });
  for (const action of ['https://evil.invalid', '__proto__', 'agents/register', 'DELETE']) await assert.rejects(session.request(action));
  for (const id of ['../agents/me', '//evil.invalid', 'x?url=https://evil.invalid', 'x%2fsecret', '']) await assert.rejects(session.request('post', {id}));
  assert.equal(calls, 0);
});
test('queries are encoded and bounded rather than interpreted as URLs', () => {
  const {operation} = setup();
  const q = 'x&url=https://evil.invalid/<script>';
  const u = new URL(operation('search', {q}).url);
  assert.equal(u.origin, 'https://www.moltbook.com'); assert.equal(u.searchParams.get('q'), q);
  assert.equal(u.searchParams.has('url'), false);
  assert.throws(() => operation('search', {q:'x'.repeat(501)}));
});
test('key in search, post title or post body is blocked before network access', async () => {
  let calls = 0; const {session} = setup(async () => { calls++; return response(); });
  await assert.rejects(session.request('search', {q:KEY}));
  await assert.rejects(session.request('createPost', {submolt:'general', title:KEY, content:'body'}));
  await assert.rejects(session.request('createPost', {submolt:'general', title:'title', content:KEY}));
  assert.equal(calls, 0);
});
test('API response and API errors cannot display an echoed raw credential', async () => {
  const {session} = setup(async () => response({success:true, api_key:KEY, nested:{content:'prefix ' + KEY + ' suffix'}, verification:{verification_code:'verification_fixture', challenge_text:'20 - 5'}}));
  const data = await session.request('me');
  assert.equal(JSON.stringify(data).includes(KEY), false); assert.equal(data.verification.verification_code, 'verification_fixture');
  const bad = setup(async () => response({success:false, error:'Bad key ' + KEY}, 401));
  await assert.rejects(bad.session.request('me'), e => !e.message.includes(KEY) && e.message.includes('401'));
});
test('non-JSON and oversized responses fail instead of executing or rendering content', async () => {
  const nonJson = setup(async () => new Response('<script>alert(1)</script>', {headers:{'content-type':'text/html'}}));
  await assert.rejects(nonJson.session.request('me'), /non-JSON/);
  const tooLarge = setup(async () => response({content:'x'.repeat(2 * 1024 * 1024)}));
  await assert.rejects(tooLarge.session.request('me'), /size limit/);
});
test('no concurrent request and no automatic retry of a failed mutation', async () => {
  let release, calls = 0;
  const {session} = setup(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  const pending = session.request('me'); await assert.rejects(session.request('me'), /already running/);
  release(response()); await pending; assert.equal(calls, 1);
  const failed = setup(async () => { calls++; throw new TypeError('network failure'); });
  await assert.rejects(failed.session.request('createPost', {submolt:'general', title:'A', content:'B'}), e => e.unknownOutcome && e.message.includes('before retrying'));
  assert.equal(calls, 2);
});
test('disconnect invalidates in-flight responses and prevents future authenticated requests', async () => {
  let release; const {session} = setup(() => new Promise(resolve => { release = resolve; }));
  const pending = session.request('me'); session.disconnect(); release(response({message:KEY}));
  await assert.rejects(pending, /discarded/); assert.equal(session.connected, false);
  await assert.rejects(session.request('me'), /Connect/);
});
test('write schemas match documented endpoints and include only allowed fields', () => {
  const {operation} = setup();
  const post = operation('createPost', {submolt:'general', title:'Test', content:'Body', url:'https://evil.invalid', api_key:KEY});
  assert.equal(post.method, 'POST'); assert.equal(post.url, 'https://www.moltbook.com/api/v1/posts');
  assert.equal(JSON.stringify(post.body), JSON.stringify({submolt_name:'general', title:'Test', content:'Body'}));
  const comment = operation('comment', {id:'post-123', content:'Reply', parent_id:'comment-456'});
  assert.equal(comment.url, 'https://www.moltbook.com/api/v1/posts/post-123/comments');
  assert.equal(comment.body.parent_id, 'comment-456');
  assert.throws(() => operation('verify', {code:'fixture', answer:'15'}));
  assert.equal(operation('verify', {code:'fixture', answer:'15.00'}).body.answer, '15.00');
});
test('a server failure after a write has an unknown outcome', async () => {
  const {session} = setup(async () => response({error:'Internal server error'}, 500));
  await assert.rejects(session.request('comment', {id:'post-123', content:'Reply'}), e => e.unknownOutcome);
});
test('post deletion is bounded to a confirmed exact post endpoint', async () => {
  const calls = [];
  const {session, operation} = setup(async (...args) => { calls.push(args); return response({success:true}); });
  for (const p of [{id:'post-123'}, {id:'post-123',confirm_id:'other'}, {id:'../agents/me',confirm_id:'../agents/me'}, {id:'',confirm_id:''}]) {
    await assert.rejects(session.request('deletePost',p));
  }
  assert.equal(calls.length,0);
  const op = operation('deletePost',{id:'post-123',confirm_id:'post-123',url:'https://evil.invalid',body:{ignored:true}});
  assert.equal(op.url,'https://www.moltbook.com/api/v1/posts/post-123');
  assert.equal(op.method,'DELETE'); assert.equal(op.body,undefined);
  await session.request('deletePost',{id:'post-123',confirm_id:'post-123'});
  assert.equal(calls.length,1); assert.equal(calls[0][1].method,'DELETE');
  assert.equal(calls[0][1].body,undefined); assert.equal(session.connected,true);
  assert.equal(calls[0][1].headers.Authorization,'Bearer ' + KEY);
});
test('deletion supports empty HTTP 204 and never retries unknown outcomes', async () => {
  const noContent = setup(async () => new Response(null,{status:204}));
  const result = await noContent.session.request('deletePost',{id:'post-123',confirm_id:'post-123'});
  assert.equal(result.success,true); assert.equal(result.deleted_post_id,'post-123');
  let calls=0;
  const failed = setup(async () => { calls++; throw new TypeError('network failure'); });
  await assert.rejects(failed.session.request('deletePost',{id:'post-123',confirm_id:'post-123'}), e => e.unknownOutcome && e.message.includes('before retrying'));
  assert.equal(calls,1);
  const serverError = setup(async () => response({error:'Internal error'},500));
  await assert.rejects(serverError.session.request('deletePost',{id:'post-123',confirm_id:'post-123'}), e => e.unknownOutcome);
});
test('repeated delete clicks cannot race an in-flight deletion', async () => {
  let release,calls=0;
  const {session} = setup(() => { calls++; return new Promise(resolve => { release=resolve; }); });
  const params={id:'post-123',confirm_id:'post-123'};
  const pending=session.request('deletePost',params);
  await assert.rejects(session.request('deletePost',params),/already running/);
  release(response()); await pending; assert.equal(calls,1);
});
test('the published page has exact CSP hashes, portable ZIP storage and no active forum HTML', () => {
  const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.ok(html.includes('sha256-' + createHash('sha256').update(script).digest('base64')));
  assert.match(html, /style-src 'none'/);
  assert.equal(html.includes('__CSP__'), false);
  assert.match(html, /connect-src https:\/\/www\.moltbook\.com/);
  assert.doesNotMatch(script, /\b(innerHTML|document\.write|eval|sendBeacon)\b/);
  assert.match(script, /globalThis\.localStorage/);
  assert.match(script, /CredentialZip\.unpack\(archive,'123'\)/);
  assert.match(script, /Max-Age=0; Secure; SameSite=Strict/);
  assert.doesNotMatch(html, /<script[^>]+src=|<img\b|<iframe\b/);
  new vm.Script(script);
});

// A deliberately small asynchronous IndexedDB fixture; no third-party dependencies.
// Only synthetic records are used; recovery never reads this obsolete database.
function browserFixture() {
  const keys = new Map(), writes = [], sessionValues = new Map(), localValues = new Map(); let cookie = '', clock = Date.now();
  const sessionStorage = {
    getItem:id => sessionValues.get(id) ?? null,
    setItem:(id,value) => sessionValues.set(id,String(value)),
    removeItem:id => sessionValues.delete(id)
  };
  const localStorage = {
    getItem:id => localValues.get(id) ?? null,
    setItem:(id,value) => localValues.set(id,String(value)),
    removeItem:id => localValues.delete(id)
  };
  const doc = {
    get cookie() { return cookie; },
    set cookie(value) {
      writes.push(value);
      cookie = value.includes('Max-Age=0;') ? '' : value.split(';')[0];
    }
  };
  const db = {
    objectStoreNames:{contains:() => true}, close() {},
    transaction() {
      let pending = 0, completeQueued = false;
      const tx = {};
      function finish() {
        if (pending || completeQueued) return; completeQueued = true;
        setImmediate(() => { completeQueued = false; if (!pending) tx.oncomplete?.(); });
      }
      function req(work) {
        pending++; const r = {};
        setImmediate(() => { r.result = work(); r.onsuccess?.(); pending--; finish(); });
        return r;
      }
      tx.objectStore = () => ({get:id => req(() => keys.get(id)), put:(key,id) => req(() => keys.set(id,key)), delete:id => req(() => keys.delete(id))});
      finish(); return tx;
    }
  };
  const idb = {open() { const req = {}; setImmediate(() => { req.result = db; req.onsuccess?.(); }); return req; }};
  const opts = {document:doc, indexedDB:idb, crypto:webcrypto, location:{href:'https://c933103.github.io/molt/'}, sessionStorage, localStorage, now:() => clock};
  return {opts, keys, writes, doc, sessionValues, localValues, localStorage, setCookie:v => { cookie = v; }, advance:ms => { clock += ms; }};
}

// Negative control: a genuinely decryptable obsolete credential must be ignored.
async function saveLegacy(f,value = KEY) {
  const scope = 'https://c933103.github.io/molt/';
  const {Zip} = setup();
  const key = await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12)), archive = Zip.pack(value,webcrypto);
  let token;
  try {
    const encrypted = await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('Moltbook browser desk v2|' + scope),tagLength:128},key,archive);
    token = 'v2.' + Buffer.concat([Buffer.from(iv),Buffer.from(encrypted)]).toString('base64url');
  } finally { archive.fill(0); }
  f.keys.set(scope,key); f.keys.set(scope + '|ciphertext',token);
  f.sessionValues.set('moltbook-browser-desk-v1|' + scope,token);
  f.doc.cookie = '__Secure-moltbook-desk-v1=' + token + '; Path=/molt/; Max-Age=34560000; Secure; SameSite=Strict';
}
const PORTABLE_NAME = 'moltbook-browser-desk-recovery-zip-v1|https://c933103.github.io/molt/';
test('persistent Base64 and the exported archive are identical password-protected ZIP bytes', async () => {
  const {Vault,Zip,session} = setup(); const f = browserFixture(), vault = new Vault(f.opts);
  const archive = session.recoveryArchive(webcrypto);
  assert.equal(await vault.save(archive),true);
  const encoded = f.localValues.get(PORTABLE_NAME);
  assert.deepEqual(Buffer.from(encoded,'base64'),Buffer.from(archive));
  assert.equal(Zip.unpack(archive),KEY);
  assert.throws(() => Zip.unpack(archive,'124'),/password|damaged/);
  assert.equal(f.keys.size,0); assert.equal(f.doc.cookie,''); assert.equal(f.sessionValues.size,0);
  const independent = spawnSync('python3',['-c',[
    'import io,sys,zipfile',
    'z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))',
    'assert z.namelist()==["api-key.txt"]',
    'assert z.getinfo("api-key.txt").flag_bits & 1',
    'assert z.getinfo("api-key.txt").compress_type==zipfile.ZIP_STORED',
    'for password in [None,b"124"]:',
    ' try: z.read("api-key.txt",pwd=password)',
    ' except RuntimeError: pass',
    ' else: raise AssertionError("Incorrect or missing password accepted")',
    'sys.stdout.buffer.write(z.read("api-key.txt",pwd=b"123"))'
  ].join('\n')],{input:Buffer.from(archive),encoding:'utf8',timeout:5000});
  assert.equal(independent.status,0,independent.stderr); assert.equal(independent.stdout,KEY);
});

test('recovery uses only localStorage after losing IndexedDB, cookies, session storage and Web Crypto', async () => {
  const {Vault,session} = setup(); const f = browserFixture();
  const archive = session.recoveryArchive(webcrypto); await new Vault(f.opts).save(archive);
  let accesses = 0;
  const forbidden = () => { accesses++; throw new Error(KEY); };
  const opts = {...f.opts,indexedDB:{open:forbidden},sessionStorage:{getItem:forbidden},document:{get cookie() { return forbidden(); }},crypto:{}};
  const restored = await new Vault(opts).restore();
  assert.equal(restored.key,KEY); assert.deepEqual(restored.archive,archive); assert.equal(accesses,0);
  session.disconnect(); session.connect(restored.key,restored.archive); restored.archive.fill(0);
  assert.deepEqual(session.recoveryArchive({}),archive,'Reload and download require no new randomness');
});

test('replacement B survives reconnect and cannot resurrect obsolete A after localStorage loss', async () => {
  const {Vault,Zip} = setup(); const f = browserFixture(); await saveLegacy(f,KEY);
  const vault = new Vault(f.opts), newer = KEY+'_replacement';
  await vault.save(Zip.pack(KEY,webcrypto)); await vault.save(Zip.pack(newer,webcrypto));
  assert.equal((await new Vault(f.opts).restore()).key,newer);
  f.localValues.clear();
  assert.equal(await new Vault(f.opts).restore(),null);
  assert.equal(f.keys.size,2,'The decryptable negative-control records still exist');
  assert.equal(f.sessionValues.size,1); assert.ok(f.doc.cookie);
});

test('obsolete v1/v2 records never restore or migrate, even when all decryption material survives', async t => {
  for (const version of [1,2]) await t.test('v'+version,async () => {
    const {Vault} = setup(); const f = browserFixture(); await saveLegacy(f,KEY);
    if (version === 1) {
      const scope='https://c933103.github.io/molt/', key=f.keys.get(scope);
      const iv=webcrypto.getRandomValues(new Uint8Array(12));
      const encrypted=await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('Moltbook browser desk v1|'+scope),tagLength:128},key,new TextEncoder().encode(JSON.stringify({key:KEY})));
      const token='v1.'+Buffer.concat([Buffer.from(iv),Buffer.from(encrypted)]).toString('base64url');
      f.keys.set(scope+'|ciphertext',token); f.sessionValues.set('moltbook-browser-desk-v1|'+scope,token); f.setCookie('__Secure-moltbook-desk-v1='+token);
    }
    const before=[...f.keys], cookie=f.doc.cookie, tab=[...f.sessionValues];
    assert.equal(await new Vault(f.opts).restore(),null);
    assert.deepEqual([...f.keys],before); assert.equal(f.doc.cookie,cookie); assert.deepEqual([...f.sessionValues],tab);
    assert.equal(f.localValues.size,0,'There is no migration');
  });
});

test('corrupt portable ZIP fails closed without exposing contents, deleting copies or falling back', async t => {
  const {Vault,Zip} = setup();
  const good=Zip.pack(KEY,webcrypto), damaged=good.slice(); damaged[45]^=255;
  for (const value of ['',KEY,'!'.repeat(240),Buffer.from(damaged).toString('base64'),Buffer.from(good.subarray(0,80)).toString('base64'),'A'.repeat(940),Buffer.from(good).toString('base64').replace(/=+$/,'')]) {
    await t.test('invalid stored value',async () => {
      const f=browserFixture(); await saveLegacy(f,KEY); f.localValues.set(PORTABLE_NAME,value);
      const before=[...f.keys], cookie=f.doc.cookie, tab=[...f.sessionValues];
      await assert.rejects(new Vault(f.opts).restore(),e => e.name==='ClientError' && /saved recovery ZIP is invalid/.test(e.message) && !e.message.includes(KEY));
      assert.equal(f.localValues.get(PORTABLE_NAME),value); assert.deepEqual([...f.keys],before); assert.equal(f.doc.cookie,cookie); assert.deepEqual([...f.sessionValues],tab);
    });
  }
});

test('denied portable storage reports a sanitized error and never uses old records', async t => {
  for (const localStorage of [null,{getItem() { throw new Error(KEY); }}]) await t.test('unavailable',async () => {
    const {Vault} = setup(); const f=browserFixture(); await saveLegacy(f,KEY);
    await assert.rejects(new Vault({...f.opts,localStorage}).restore(),e => /Browser persistent ZIP storage is unavailable/.test(e.message) && /Saved copies were not removed/.test(e.message) && !e.message.includes(KEY));
    assert.equal(f.keys.size,2); assert.equal(f.localValues.size,0);
  });
});

test('empty readable storage returns no connection with no writes or network access', async () => {
  let calls=0; const {Vault}=setup(() => { calls++; throw new Error(); }); const f=browserFixture();
  assert.equal(await new Vault(f.opts).restore(),null);
  assert.equal(f.keys.size,0); assert.equal(f.writes.length,0); assert.equal(f.sessionValues.size,0); assert.equal(calls,0);
});

test('failed ZIP writes retain the previous copy and sanitize storage errors', async () => {
  const {Vault,Zip}=setup(); const f=browserFixture(); await new Vault(f.opts).save(Zip.pack(KEY,webcrypto));
  const original=f.localValues.get(PORTABLE_NAME);
  const denied={getItem:() => original,setItem() { throw new Error(KEY); }};
  await assert.rejects(new Vault({...f.opts,localStorage:denied}).save(Zip.pack(KEY+'_new',webcrypto)),e => /could not save the recovery ZIP/.test(e.message) && !e.message.includes(KEY));
  assert.equal(f.localValues.get(PORTABLE_NAME),original); assert.equal((await new Vault(f.opts).restore()).key,KEY);
  const ignored={getItem:() => original,setItem() {}};
  await assert.rejects(new Vault({...f.opts,localStorage:ignored}).save(Zip.pack(KEY+'_new',webcrypto)),/could not save the recovery ZIP/);
});

test('save validates a bounded ZIP before changing storage and owns the queued bytes', async () => {
  const {Vault,Zip}=setup(); const f=browserFixture(), vault=new Vault(f.opts);
  for (const invalid of [KEY,new Uint8Array(10000),Zip.pack(KEY,webcrypto,'other')]) await assert.rejects(vault.save(invalid),/Invalid recovery ZIP/);
  assert.equal(f.localValues.size,0);
  const archive=Zip.pack(KEY,webcrypto), original=archive.slice();
  const pending=vault.save(archive); archive.fill(0); assert.equal(await pending,true);
  assert.deepEqual((await vault.restore()).archive,original);
});

test('one generated archive is reused for repeated export and same-key reconnect; replacement invalidates it', () => {
  const {session,Zip}=setup(); let randomCalls=0;
  const crypt={getRandomValues(bytes) { randomCalls++; return webcrypto.getRandomValues(bytes); }};
  const archive=session.recoveryArchive(crypt), copy=archive.slice(); archive.fill(0);
  session.connect(KEY);
  assert.deepEqual(session.recoveryArchive(crypt),copy); assert.equal(randomCalls,1);
  session.connect(KEY+'_new'); const newer=session.recoveryArchive(crypt);
  assert.equal(Zip.unpack(newer),KEY+'_new'); assert.notDeepEqual(newer,copy); assert.equal(randomCalls,2);
  session.disconnect(); assert.throws(() => session.recoveryArchive(crypt),/Connect this browser/);
});

test('restored archive must match the session credential', () => {
  const {session,Zip}=setup(); const archive=session.recoveryArchive(webcrypto);
  assert.throws(() => session.connect(KEY,Zip.pack(KEY+'_other',webcrypto)),/does not match/);
  assert.deepEqual(session.recoveryArchive({}),archive);
});

test('forget deletes portable and obsolete records, with no encryption API or stored-key reads', async () => {
  const {Vault,Zip}=setup(); const f=browserFixture(); await saveLegacy(f,KEY);
  const vault=new Vault({...f.opts,crypto:{}}); await vault.save(Zip.pack(KEY+'_new',webcrypto));
  const scope='https://c933103.github.io/another/'; f.keys.set(scope,'unrelated'); f.sessionValues.set('unrelated','keep'); f.localValues.set('unrelated','keep');
  await vault.forget();
  assert.equal(f.localValues.has(PORTABLE_NAME),false); assert.deepEqual([...f.keys],[[scope,'unrelated']]);
  assert.deepEqual([...f.sessionValues],[['unrelated','keep']]); assert.equal(f.doc.cookie,'');
  assert.equal(f.localValues.get('unrelated'),'keep'); assert.equal(await vault.restore(),null);
});

test('forget cancels queued save and restore so neither can resurrect a credential', async () => {
  const {Vault,Zip}=setup(); const f=browserFixture(), vault=new Vault(f.opts); await vault.save(Zip.pack(KEY,webcrypto));
  const saving=vault.save(Zip.pack(KEY+'_new',webcrypto)), restoring=vault.restore(), forgetting=vault.forget();
  assert.equal(await saving,false); assert.equal(await restoring,null); await forgetting;
  assert.equal(await vault.restore(),null); assert.equal(f.localValues.size,0);
});

test('forget works without IndexedDB; cleanup failures remain explicit after portable deletion', async t => {
  const {Vault,Zip}=setup();
  for (const mode of ['absent','blocked','session','persistent']) await t.test(mode,async () => {
    const f=browserFixture(); await saveLegacy(f,KEY); await new Vault(f.opts).save(Zip.pack(KEY,webcrypto));
    if (mode==='absent') f.opts.indexedDB=null;
    if (mode==='blocked') f.opts.indexedDB={open() { throw new Error(KEY); }};
    if (mode==='session') f.opts.sessionStorage={removeItem() { throw new Error(KEY); }};
    if (mode==='persistent') f.opts.localStorage={...f.localStorage,removeItem() {}};
    const vault=new Vault(f.opts);
    if (mode==='absent') await vault.forget();
    else await assert.rejects(vault.forget(),e => /did not remove all saved copies/.test(e.message) && !e.message.includes(KEY));
    assert.equal(f.localValues.has(PORTABLE_NAME),mode==='persistent');
    if (mode!=='persistent') assert.equal(await vault.restore(),null);
  });
});

test('forget reports denied obsolete-store getters instead of claiming complete cleanup', async t => {
  for (const capability of ['indexedDB','sessionStorage']) await t.test(capability,async () => {
    const globals={}; Object.defineProperty(globals,capability,{get() { throw new Error(KEY); }});
    const {Vault,Zip}=setup(undefined,globals); const f=browserFixture();
    const vault=new Vault({...f.opts,[capability]:undefined}); await vault.save(Zip.pack(KEY,webcrypto));
    await assert.rejects(vault.forget(),e => /did not remove all saved copies/.test(e.message) && !e.message.includes(KEY));
    assert.equal(f.localValues.size,0); assert.equal(await vault.restore(),null);
  });
});

test('transient localStorage failure can be retried without changing the saved bytes', async () => {
  const {Vault,Zip}=setup(); const f=browserFixture(); const archive=Zip.pack(KEY,webcrypto);
  await new Vault(f.opts).save(archive); let blocked=true;
  const localStorage={...f.localStorage,getItem(name) { if (blocked) throw new Error(KEY); return f.localStorage.getItem(name); }};
  const vault=new Vault({...f.opts,localStorage});
  await assert.rejects(vault.restore(),/Saved connection status could not be checked/); blocked=false;
  assert.deepEqual((await vault.restore()).archive,archive);
});

test('HTTPS and page namespace checks remain, without treating path scope as same-origin isolation', async () => {
  const {Vault,Zip}=setup(); const f=browserFixture();
  assert.throws(() => new Vault({...f.opts,location:{href:'http://example.invalid/molt/'}}),/HTTPS/);
  await new Vault(f.opts).save(Zip.pack(KEY,webcrypto));
  assert.equal(await new Vault({...f.opts,location:{href:'https://c933103.github.io/another/'}}).restore(),null);
  assert.equal((await new Vault(f.opts).restore()).key,KEY);
});

test('external ZIP restores authentication after loss of every browser store', async () => {
  let authorization; const {Vault,Zip,session}=setup(async (_,opts) => { authorization=opts.headers.Authorization; return response(); });
  const f=browserFixture(), archive=session.recoveryArchive(webcrypto); await new Vault(f.opts).save(archive);
  session.disconnect(); f.localValues.clear(); f.keys.clear(); f.sessionValues.clear(); f.setCookie('');
  const key=await Zip.importArchive(archive); session.connect(key,archive); await session.request('me');
  const vault=new Vault({...f.opts,indexedDB:null}); await vault.save(session.recoveryArchive({}));
  assert.equal(authorization,'Bearer '+KEY); assert.equal((await vault.restore()).key,KEY);
  assert.deepEqual(Buffer.from(f.localValues.get(PORTABLE_NAME),'base64'),Buffer.from(archive));
  assert.equal(JSON.stringify(session).includes(KEY),false);
});

test('ZIP parser rejects malformed, oversized, damaged and path-bearing archives', () => {
  const {Zip} = setup(); const archive = Zip.pack(KEY,webcrypto);
  assert.equal(Zip.unpack(Zip.pack('Z'.repeat(512),webcrypto)),'Z'.repeat(512));
  assert.throws(() => Zip.pack('Z'.repeat(513),webcrypto));
  for (const bad of [archive.slice(0,-1),new Uint8Array(10000),new Uint8Array(archive.length+1)]) assert.throws(() => Zip.unpack(bad));
  for (const offset of [0,6,18,22,26,28,30,45,archive.length-22,archive.length-14]) {
    const bad = archive.slice(); bad[offset] ^= 255; assert.throws(() => Zip.unpack(bad));
  }
});

test('comment upvote uses only the exact comment endpoint and rejects malformed IDs before sending', async () => {
  const calls=[]; const {session,operation}=setup(async (...args) => { calls.push(args); return response({success:true,action:'added'}); });
  for (const id of ['', '../posts/other', 'x/upvote', 'x?requester_id=other', 'x%2fupvote', 'x'.repeat(81), null]) {
    await assert.rejects(session.request('commentUpvote',{id}));
  }
  await assert.rejects(session.request('commentUpvote',{id:'reply-123',post_id:'../other'}));
  await assert.rejects(session.request('commentDownvote',{id:'reply-123'}));
  assert.equal(calls.length,0);
  const op=operation('commentUpvote',{id:'reply-123',post_id:'parent-456',body:{ignored:true},url:'https://evil.invalid'});
  assert.equal(op.method,'POST'); assert.equal(op.url,'https://www.moltbook.com/api/v1/comments/reply-123/upvote'); assert.equal(op.body,undefined);
  await session.request('commentUpvote',{id:'reply-123',post_id:'parent-456'});
  assert.equal(calls.length,1);
  assert.equal(calls[0][1].headers.Authorization,'Bearer '+KEY);
  assert.equal(calls[0][1].headers['Content-Type'],undefined); assert.equal(calls[0][1].body,undefined);
  assert.equal(calls[0][1].credentials,'omit'); assert.equal(calls[0][1].redirect,'error');
});

test('comment readback derives requester_id from the connected account and preserves unclassified server data', async () => {
  const calls=[]; const raw={success:true,comments:[{id:'reply-123',content:'Public',upvotes:1,fixture_vote_field:'unclassified',echo:KEY}],has_more:true,next_cursor:'next'};
  const {session,operation}=setup(async (...args) => { calls.push(args); return response(args[0].endsWith('/agents/me') ? {success:true,agent:{id:'agent-123'}} : raw); });
  const cursor='cursor?other=value&x=y';
  const data=await session.request('commentReadback',{id:'parent-456',cursor});
  assert.equal(calls.length,2); assert.equal(calls[0][0],'https://www.moltbook.com/api/v1/agents/me');
  const url=new URL(calls[1][0]); assert.equal(url.pathname,'/api/v1/posts/parent-456/comments');
  assert.equal(url.searchParams.get('requester_id'),'agent-123'); assert.equal(url.searchParams.get('cursor'),cursor);
  assert.equal(url.searchParams.get('sort'),'new'); assert.equal(url.searchParams.get('limit'),'35');
  assert.equal(url.searchParams.has('other'),false);
  assert.equal(data.type,'comment_vote_readback'); assert.equal(data.post_id,'parent-456'); assert.equal(data.requester_id,'agent-123');
  assert.equal(data.vote_state,'unknown'); assert.equal(data.response.comments[0].fixture_vote_field,'unclassified');
  assert.equal(data.response.comments[0].echo,'[credential removed]'); assert.equal(data.response.has_more,true);
  assert.throws(() => operation('comments',{id:'parent',requester_id:'other&injected=value'}));
  for (const action of ['comments','commentReadback']) await assert.rejects(session.request(action,{id:'parent',requester_id:'someone-else'}),/cannot be supplied/);
  assert.equal(calls.length,2,'Caller-selected requester must never be sent');
});

test('unknown account identity stops scoped readback without guessing a requester', async () => {
  for (const id of [undefined,null,'','../other',KEY]) {
    let calls=0; const {session}=setup(async () => { calls++; return response({success:true,agent:{id}}); });
    await assert.rejects(session.request('commentReadback',{id:'parent'}),/public ID is unavailable/);
    assert.equal(calls,1);
  }
});

test('comment readback locks its two reads together and disconnect prevents the second fetch', async () => {
  let finish; const calls=[];
  const {session}=setup((...args) => { calls.push(args); return new Promise(resolve => { finish=resolve; }); });
  const pending=session.request('commentReadback',{id:'parent'});
  await assert.rejects(session.request('commentUpvote',{id:'reply'}),/already running/);
  session.disconnect(); finish(response({success:true,agent:{id:'agent-123'}}));
  await assert.rejects(pending,/discarded/); assert.equal(calls.length,1);
});

test('comment votes retain a page-lifetime duplicate guard after every received or uncertain outcome', async () => {
  for (const outcome of ['added','removed','unchanged','unspecified','network','server','malformed','non-json']) {
    let calls=0; const {session}=setup(async () => {
      calls++;
      if (outcome==='network') throw new Error('synthetic transport failure');
      if (outcome==='server') return response({error:'server failure'},500);
      if (outcome==='malformed') return new Response('{',{headers:{'content-type':'application/json'}});
      if (outcome==='non-json') return new Response('<html>no</html>',{headers:{'content-type':'text/html'}});
      return response({success:true,...(outcome==='unspecified' ? {} : {action:outcome}),secret:'synthetic',echo:KEY});
    });
    if (['network','server','malformed','non-json'].includes(outcome)) await assert.rejects(session.request('commentUpvote',{id:'reply'}),e=>e.unknownOutcome);
    else {
      const result=await session.request('commentUpvote',{id:'reply'});
      assert.equal(result.action,outcome==='unspecified' ? undefined : outcome);
      assert.equal(result.echo,'[credential removed]'); assert.equal(result.secret,'[credential removed]');
    }
    assert.equal(session.commentVoteAttempted('reply'),true);
    await assert.rejects(session.request('commentUpvote',{id:'reply'}),/already attempted/);
    session.disconnect(); session.connect(KEY);
    await assert.rejects(session.request('commentUpvote',{id:'reply'}),/already attempted/);
    assert.equal(calls,1,'No retries, even after reconnect, for '+outcome);
  }
});

test('a definite rejected comment vote permits an explicit retry but never retries automatically', async () => {
  let calls=0; const {session}=setup(async () => { calls++; return response({success:false,error:'Rejected '+KEY},429,{'Retry-After':'60'}); });
  await assert.rejects(session.request('commentUpvote',{id:'reply'}),e=>!e.unknownOutcome && !e.message.includes(KEY) && /rate limit/.test(e.message));
  assert.equal(calls,1); assert.equal(session.commentVoteAttempted('reply'),false);
  await assert.rejects(session.request('commentUpvote',{id:'reply'})); assert.equal(calls,2);
});

test('comment upvote remains serialized and a disconnected late response cannot clear its guard', async () => {
  let finish,calls=0; const {session}=setup(async () => { calls++; return new Promise(resolve=>{finish=resolve;}); });
  const pending=session.request('commentUpvote',{id:'reply'});
  await assert.rejects(session.request('commentUpvote',{id:'reply'}),/already running/);
  session.disconnect(); finish(response({success:true,echo:KEY}));
  await assert.rejects(pending,e=>e.unknownOutcome); assert.equal(session.commentVoteAttempted('reply'),true); assert.equal(calls,1);
});

test('removal uses only the exact upvote subresource after a fresh scoped preflight', async () => {
  const calls=[]; const {session,operation}=setup(async (url,options)=>{
    calls.push([url,options]);
    if(url.endsWith('/agents/me')) return response({agent:{id:'agent-fixture'}});
    if(options.method==='DELETE') return response({success:true,action:'removed',echo:KEY});
    const cursor=new URL(url).searchParams.get('cursor');
    return response(cursor ? {comments:[{id:'root',replies:[{id:'reply',post_id:'parent',user_vote:1}]}],has_more:false} : {comments:[],has_more:true,next_cursor:'page-2'});
  });
  const p={id:'reply',post_id:'parent',confirm_id:'reply'};
  const op=operation('commentRemoveUpvote',p);
  assert.equal(op.url,'https://www.moltbook.com/api/v1/comments/reply/upvote'); assert.equal(op.method,'DELETE'); assert.equal(op.body,undefined);
  const data=await session.request('commentRemoveUpvote',p);
  assert.equal(calls.length,4); assert.equal(calls[0][0],'https://www.moltbook.com/api/v1/agents/me');
  for(const [url,opts] of calls.slice(1,3)) { assert.equal(opts.method,'GET'); assert.equal(new URL(url).searchParams.get('requester_id'),'agent-fixture'); }
  assert.equal(calls[3][0],op.url); assert.equal(calls[3][1].method,'DELETE'); assert.equal(calls[3][1].body,undefined);
  assert.equal(data.preflight.user_vote,1); assert.equal(data.preflight.comment_id,'reply'); assert.equal(data.preflight.post_id,'parent'); assert.equal(data.preflight.requester_id,'agent-fixture');
  assert.equal(data.contract,'unverified_compatibility'); assert.equal(data.removal_verified,false); assert.equal(data.response.echo,'[credential removed]');
  await assert.rejects(session.request('commentRemoveUpvote',p),/already attempted/);
  await assert.rejects(session.request('commentUpvote',{id:'reply'}),/already attempted/);
  assert.equal(calls.length,4);
});

test('removal rejects invalid target, confirmation and caller account overrides before network access', async () => {
  let calls=0;const {session}=setup(async()=>{calls++;return response();});
  const base={id:'reply',post_id:'parent',confirm_id:'reply'};
  for(const extra of [{id:'../parent',confirm_id:'../parent'},{id:'reply/upvote',confirm_id:'reply/upvote'},{post_id:'../parent'},{post_id:undefined},{confirm_id:'parent'},{requester_id:'other'},{cursor:'page'},{post_id:KEY}])
    await assert.rejects(session.request('commentRemoveUpvote',{...base,...extra}));
  assert.equal(calls,0);
});

test('removal never infers an own upvote from counts, ambiguous targets or unknown vote fields', async () => {
  for(const fields of [{user_vote:0},{user_vote:-1},{user_vote:'1'},{user_vote:null},{upvotes:100},{user_vote:1,post_id:'other'},{user_vote:1,post:{id:'other'}}]) {
    const calls=[];const {session}=setup(async(url,opts)=>{calls.push(opts.method);return response(url.endsWith('/agents/me')?{agent:{id:'agent'}}:{comments:[{id:'reply',...fields}]});});
    await assert.rejects(session.request('commentRemoveUpvote',{id:'reply',post_id:'parent',confirm_id:'reply'}),/No comment vote change sent/);
    assert.deepEqual(calls,['GET','GET']); assert.equal(session.commentRemovalAttempted('reply'),false);
  }
  for(const data of [{comments:[]},{comments:[{id:'reply',user_vote:1},{id:'reply',user_vote:1}]},{comments:[],has_more:true,next_cursor:''},{comments:[],has_more:true,next_cursor:'repeat'},{unexpected:[]}]) {
    const calls=[];const {session}=setup(async(url,opts)=>{calls.push(opts.method);return response(url.endsWith('/agents/me')?{agent:{id:'agent'}}:data);});
    await assert.rejects(session.request('commentRemoveUpvote',{id:'reply',post_id:'parent',confirm_id:'reply'}),/No comment vote change sent/);
    assert.equal(calls.includes('DELETE'),false);
  }
});

test('every DELETE outcome is guarded without retry or fallback and never claims removal', async () => {
  for(const outcome of ['removed','unchanged','204','404','405','500','network','malformed','non-json']) {
    const calls=[];const {session}=setup(async(url,opts)=>{
      calls.push(opts.method);
      if(opts.method!=='DELETE') return response(url.endsWith('/agents/me')?{agent:{id:'agent'}}:{comments:[{id:'reply',user_vote:1}]});
      if(outcome==='network') throw new Error('synthetic failure');
      if(outcome==='204') return new Response(null,{status:204});
      if(/^\d+$/.test(outcome)) return response({success:false,message:'unsupported '+KEY},Number(outcome));
      if(outcome==='malformed') return new Response('{',{headers:{'content-type':'application/json'}});
      if(outcome==='non-json') return new Response('unsupported',{headers:{'content-type':'text/plain'}});
      return response({success:true,action:outcome});
    });
    const p={id:'reply',post_id:'parent',confirm_id:'reply'};
    if(['removed','unchanged','204'].includes(outcome)) assert.equal((await session.request('commentRemoveUpvote',p)).removal_verified,false);
    else await assert.rejects(session.request('commentRemoveUpvote',p),err=>err.unknownOutcome===['500','network','malformed','non-json'].includes(outcome)&&!err.message.includes(KEY));
    session.disconnect();session.connect(KEY);
    await assert.rejects(session.request('commentRemoveUpvote',p),/already attempted/);
    await assert.rejects(session.request('commentUpvote',{id:'reply'}),/already attempted/);
    assert.deepEqual(calls,['GET','GET','DELETE'],outcome);
  }
});

test('disconnect during removal preflight prevents DELETE; disconnect after DELETE is unknown and guarded', async () => {
  for(const stage of ['preflight','mutation']) {
    let finish;const calls=[];const {session}=setup(async(url,opts)=>{
      calls.push(opts.method);
      if(url.endsWith('/agents/me')) return response({agent:{id:'agent'}});
      if(stage==='preflight'||opts.method==='DELETE') return new Promise(resolve=>{finish=resolve;});
      return response({comments:[{id:'reply',user_vote:1}]});
    });
    const pending=session.request('commentRemoveUpvote',{id:'reply',post_id:'parent',confirm_id:'reply'});
    while(!finish) await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(session.request('me'),/already running/);
    session.disconnect();finish(response(stage==='preflight'?{comments:[{id:'reply',user_vote:1}]}:{success:true,action:'removed'}));
    await assert.rejects(pending,err=>err.unknownOutcome===(stage==='mutation'));
    assert.deepEqual(calls,stage==='preflight'?['GET','GET']:['GET','GET','DELETE']);
    assert.equal(session.commentRemovalAttempted('reply'),stage==='mutation');
  }
});

test('removal snapshots the exact target before asynchronous preflight', async () => {
  let release;const calls=[];const {session}=setup(async(url,opts)=>{
    calls.push([url,opts.method]);
    if(url.endsWith('/agents/me')) return new Promise(resolve=>{release=resolve;});
    return response(opts.method==='DELETE'?{success:true}:{comments:[{id:'reply',user_vote:1}]});
  });
  const p={id:'reply',post_id:'parent',confirm_id:'reply'};const pending=session.request('commentRemoveUpvote',p);
  p.id='other';p.post_id='wrong';p.confirm_id='other';release(response({agent:{id:'agent'}}));
  const result=await pending;assert.equal(result.comment_id,'reply');assert.equal(result.post_id,'parent');
  assert.match(calls[1][0],/posts\/parent\/comments/);assert.equal(calls[2][0],'https://www.moltbook.com/api/v1/comments/reply/upvote');
});

test('removal fails closed on missing identity, wrong response parent and bounded pagination', async () => {
  for(const mode of ['identity','parent','pages','nodes']) {
    let pages=0;const methods=[];const {session}=setup(async(url,opts)=>{
      methods.push(opts.method);
      if(url.endsWith('/agents/me')) return response({agent:{id:mode==='identity'?undefined:'agent'}});
      pages++;
      return response(mode==='parent'?{post_id:'wrong',comments:[{id:'reply',user_vote:1}]}:mode==='nodes'?{comments:Array.from({length:5001},()=>({id:'other'}))}:{comments:[],has_more:true,next_cursor:'page-'+pages});
    });
    await assert.rejects(session.request('commentRemoveUpvote',{id:'reply',post_id:'parent',confirm_id:'reply'}),/No comment vote change sent/);
    assert.equal(methods.includes('DELETE'),false);if(mode==='pages')assert.equal(pages,20);if(mode==='identity')assert.equal(pages,0);
  }
});

test('removal failure identifies preflight versus DELETE without copying headers or query values', async () => {
  for (const stage of ['identity','comments','delete','network']) {
    const calls=[];const {session}=setup(async(url,opts)=>{
      calls.push(opts.method);
      const here=url.endsWith('/agents/me')?'identity':opts.method==='DELETE'?'delete':'comments';
      if(stage==='network'&&here==='delete')throw new Error('transport '+KEY);
      if(here===stage)return response({error:'Not Found',message:'Cannot '+opts.method+' '+KEY,authorization:KEY},404);
      return response(here==='identity'?{agent:{id:'agent-fixture'}}:{comments:[{id:'reply',user_vote:1}]});
    });
    await assert.rejects(session.request('commentRemoveUpvote',{id:'reply',post_id:'parent',confirm_id:'reply'}),err=>{
      const r=JSON.parse(JSON.stringify(err.removalAttempt));
      assert.equal(r.phase,['delete','network'].includes(stage)?'removal':'preflight');
      assert.equal(r.mutation_sent,['delete','network'].includes(stage));assert.equal(r.removal_verified,false);
      assert.equal(r.failed_request.sent,true);assert.equal(r.failed_request.method,['delete','network'].includes(stage)?'DELETE':'GET');
      assert.equal(r.failed_request.path,stage==='identity'?'/api/v1/agents/me':stage==='comments'?'/api/v1/posts/parent/comments':'/api/v1/comments/reply/upvote');
      assert.equal(r.failed_request.http_status,stage==='network'?undefined:404);
      assert.equal(err.unknownOutcome,stage==='network');
      assert.equal(Boolean(r.preflight),['delete','network'].includes(stage));
      assert.doesNotMatch(JSON.stringify(r),/Authorization|Bearer|\?|moltbook_test_fixture|transport/);
      return true;
    });
    assert.equal(calls.filter(x=>x==='DELETE').length,['delete','network'].includes(stage)?1:0);
  }
});

test('vote preflight guard failure reports no mutation and no invented failed request', async () => {
  const {session}=setup(async url=>response(url.endsWith('/agents/me')?{agent:{id:'agent'}}:{comments:[{id:'reply',user_vote:0}]}));
  await assert.rejects(session.request('commentRemoveUpvote',{id:'reply',post_id:'parent',confirm_id:'reply'}),err=>{
    assert.equal(err.removalAttempt.phase,'preflight');assert.equal(err.removalAttempt.mutation_sent,false);
    assert.equal(err.removalAttempt.failed_request,undefined);assert.equal(err.removalAttempt.removal_verified,false);return true;
  });
});

test('authorized comment downvote is exact, guarded and never called neutral removal', async()=>{
  for(const outcome of ['downvoted','unchanged','404','500','network']){
    const calls=[];const {session}=setup(async(url,opts)=>{
      calls.push([url,opts]);
      if(opts.method==='GET')return response(url.endsWith('/agents/me')?{agent:{id:'agent'}}:{comments:[{id:'reply',post_id:'parent',user_vote:1}]});
      if(outcome==='network')throw new Error('synthetic');
      if(/^\d+$/.test(outcome))return response({error:'failure'},Number(outcome));
      return response({success:true,action:outcome});
    });
    const p={id:'reply',post_id:'parent',confirm_id:'reply'};
    if(['downvoted','unchanged'].includes(outcome)){
      const result=await session.request('commentDownvote',p);assert.equal(result.vote_verified,false);assert.equal(result.contract,'unverified_compatibility');assert.equal(result.removal_verified,undefined);
    }else await assert.rejects(session.request('commentDownvote',p),e=>e.unknownOutcome===['500','network'].includes(outcome));
    assert.deepEqual(calls.map(c=>c[1].method),['GET','GET','POST']);
    assert.equal(calls[2][0],'https://www.moltbook.com/api/v1/comments/reply/downvote');assert.equal(calls[2][1].body,undefined);
    session.disconnect();session.connect(KEY);
    await assert.rejects(session.request('commentDownvote',p),/already attempted/);await assert.rejects(session.request('commentUpvote',{id:'reply'}),/already attempted/);assert.equal(calls.length,3);
  }
});

test('comment downvote rejects unsafe targets or own state before mutation',async()=>{
  for(const state of [0,-1,'1',null,undefined]){
    const methods=[];const {session}=setup(async(url,o)=>{methods.push(o.method);return response(url.endsWith('/agents/me')?{agent:{id:'agent'}}:{comments:[{id:'reply',user_vote:state}]});});
    await assert.rejects(session.request('commentDownvote',{id:'reply',post_id:'parent',confirm_id:'reply'}),/No comment vote change sent/);assert.deepEqual(methods,['GET','GET']);
  }
  let calls=0;const {session}=setup(async()=>{calls++;return response();});
  for(const extra of [{id:'../parent',confirm_id:'../parent'},{confirm_id:'different'},{post_id:undefined},{requester_id:'other'},{cursor:'x'}])await assert.rejects(session.request('commentDownvote',{id:'reply',post_id:'parent',confirm_id:'reply',...extra}));
  assert.equal(calls,0);
});

test('downvote failure receipts distinguish preflight from the one POST and retain its guard',async()=>{
  for(const stage of ['preflight','mutation']){
    const calls=[];const {session}=setup(async(url,o)=>{calls.push([url,o.method]);if(url.endsWith('/agents/me'))return response({agent:{id:'agent'}});if(stage==='preflight'||o.method==='POST')return response({error:'Not Found'},404);return response({comments:[{id:'reply',user_vote:1}]});});
    await assert.rejects(session.request('commentDownvote',{id:'reply',post_id:'parent',confirm_id:'reply'}),err=>{
      assert.equal(err.voteAttempt.phase,stage==='mutation'?'downvote':'preflight');assert.equal(err.voteAttempt.mutation_sent,stage==='mutation');assert.equal(err.voteAttempt.failed_request.method,stage==='mutation'?'POST':'GET');assert.equal(err.voteAttempt.failed_request.http_status,404);assert.equal(err.voteAttempt.vote_verified,false);assert.equal(err.removalAttempt,undefined);return true;
    });
    assert.equal(session.commentDownvoteAttempted('reply'),stage==='mutation');assert.equal(calls.filter(c=>c[1]==='POST').length,stage==='mutation'?1:0);
  }
});

test('downvote snapshots target and blocks mutation after disconnect during preflight',async()=>{
  for(const disconnect of [false,true]){
    let finish;const calls=[];const {session}=setup(async(url,o)=>{calls.push([url,o.method]);if(url.endsWith('/agents/me'))return new Promise(resolve=>{finish=resolve;});return response(o.method==='POST'?{success:true}:{comments:[{id:'reply',user_vote:1}]});});
    const p={id:'reply',post_id:'parent',confirm_id:'reply'};const pending=session.request('commentDownvote',p);p.id='other';p.post_id='other-parent';p.confirm_id='other';if(disconnect)session.disconnect();finish(response({agent:{id:'agent'}}));
    if(disconnect){await assert.rejects(pending);assert.equal(calls.length,1);assert.equal(session.commentDownvoteAttempted('reply'),false);}else{const r=await pending;assert.equal(r.comment_id,'reply');assert.equal(r.post_id,'parent');assert.equal(calls.at(-1)[0],'https://www.moltbook.com/api/v1/comments/reply/downvote');}
  }
});

test('explicit expected -1 repeat sends one exact POST and never assumes undo', async()=>{
  for(const outcome of ['downvoted','removed','404','500','network']){
    const calls=[];const {session}=setup(async(url,opts)=>{
      calls.push([url,opts]);
      if(opts.method==='GET')return response(url.endsWith('/agents/me')?{agent:{id:'agent'}}:{comments:[{id:'reply',post_id:'parent',user_vote:-1}]});
      if(outcome==='network')throw new Error('synthetic');
      return /^\d+$/.test(outcome)?response({error:'failure'},Number(outcome)):response({success:true,action:outcome});
    });
    const p={id:'reply',post_id:'parent',confirm_id:'reply',expected_vote:-1,confirm_repeat:true};
    if(['downvoted','removed'].includes(outcome)){
      const r=await session.request('commentDownvote',p);assert.equal(r.preflight.user_vote,-1);assert.equal(r.repeat_experiment,true);assert.equal(r.vote_verified,false);assert.equal(r.removal_verified,undefined);
    }else await assert.rejects(session.request('commentDownvote',p),e=>e.unknownOutcome===['500','network'].includes(outcome));
    assert.deepEqual(calls.map(x=>x[1].method),['GET','GET','POST']);assert.equal(calls[2][0],'https://www.moltbook.com/api/v1/comments/reply/downvote');assert.equal(calls[2][1].body,undefined);
    session.disconnect();session.connect(KEY);
    for(const expected_vote of [-1,1])await assert.rejects(session.request('commentDownvote',{...p,expected_vote}),/already attempted/);
    assert.equal(calls.length,3);
  }
});

test('expected vote and repeat confirmation fail closed; neutral removal stays +1-only', async()=>{
  let calls=0;const {session}=setup(async()=>{calls++;return response();});
  const p={id:'reply',post_id:'parent',confirm_id:'reply'};
  for(const expected_vote of [0,'-1','1',null,NaN,2])await assert.rejects(session.request('commentDownvote',{...p,expected_vote,confirm_repeat:true}),/Expected/);
  for(const confirm_repeat of [undefined,false,'true','yes',1])await assert.rejects(session.request('commentDownvote',{...p,expected_vote:-1,confirm_repeat}),/Explicitly confirm/);
  assert.equal(calls,0);
  for(const state of [1,0,'-1',null,undefined]){
    const methods=[];const f=setup(async(url,o)=>{methods.push(o.method);return response(url.endsWith('/agents/me')?{agent:{id:'agent'}}:{comments:[{id:'reply',user_vote:state}]});});
    await assert.rejects(f.session.request('commentDownvote',{...p,expected_vote:-1,confirm_repeat:true}),/not exactly -1/);assert.deepEqual(methods,['GET','GET']);
  }
  const f=setup(async url=>response(url.endsWith('/agents/me')?{agent:{id:'agent'}}:{comments:[{id:'reply',user_vote:-1}]}));
  await assert.rejects(f.session.request('commentRemoveUpvote',{...p,expected_vote:-1,confirm_repeat:true}),/not exactly 1/);
});
