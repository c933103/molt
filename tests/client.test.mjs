import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, webcrypto} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const core = html.match(/\/\/ BEGIN CLIENT\n([\s\S]*?)\/\/ END CLIENT/)[1];
const KEY = 'moltbook_test_fixture_never_a_real_key';
function setup(fetchImpl) {
  const context = {fetch:fetchImpl, URL, URLSearchParams, AbortController, TextDecoder, TextEncoder, Uint8Array, btoa, atob, setTimeout, clearTimeout};
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
test('the published page has exact CSP hashes, encrypted cookie storage and no active forum HTML', () => {
  const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.ok(html.includes('sha256-' + createHash('sha256').update(script).digest('base64')));
  assert.match(html, /style-src 'none'/);
  assert.equal(html.includes('__CSP__'), false);
  assert.match(html, /connect-src https:\/\/www\.moltbook\.com/);
  assert.doesNotMatch(script, /\b(localStorage|innerHTML|document\.write|eval|sendBeacon)\b/);
  assert.match(script, /generateKey\(\{name:'AES-GCM', length:256\}, false/);
  assert.match(script, /Max-Age=.*Secure; SameSite=Strict/);
  assert.doesNotMatch(html, /<script[^>]+src=|<img\b|<iframe\b/);
  new vm.Script(script);
});

// A deliberately small asynchronous IndexedDB fixture; no third-party dependencies.
// The real Web Crypto implementation performs every encrypt/decrypt operation.
function browserFixture() {
  const keys = new Map(), writes = [], sessionValues = new Map(); let cookie = '', clock = Date.now();
  const sessionStorage = {
    getItem:id => sessionValues.get(id) ?? null,
    setItem:(id,value) => sessionValues.set(id,String(value)),
    removeItem:id => sessionValues.delete(id)
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
  const opts = {document:doc, indexedDB:idb, crypto:webcrypto, location:{href:'https://c933103.github.io/molt/'}, sessionStorage, now:() => clock};
  return {opts, keys, writes, doc, sessionValues, setCookie:v => { cookie = v; }, advance:ms => { clock += ms; }};
}
test('saved cookie and browser backup are encrypted; the wrapping key cannot be exported', async () => {
  const {Vault} = setup(); const f = browserFixture(); const vault = new Vault(f.opts);
  assert.equal(await vault.save(KEY), true);
  assert.equal(f.writes.some(w => w.includes(KEY)), false);
  assert.match(f.doc.cookie, /^__Secure-moltbook-desk-v1=v2\.[A-Za-z0-9_-]+$/);
  assert.match(f.writes[0], /Path=\/molt\/; Max-Age=34560000; Secure; SameSite=Strict$/);
  const key = [...f.keys.values()][0];
  assert.equal(key.extractable, false);
  assert.equal([...f.keys.values()].some(v => typeof v === 'string' && v.includes(KEY)), false);
  assert.equal(f.sessionValues.size,1);
  assert.equal([...f.sessionValues.values()][0],f.doc.cookie.split('=')[1]);
  assert.equal([...f.sessionValues.values()].some(v => v.includes(KEY)),false);
  await assert.rejects(webcrypto.subtle.exportKey('raw', key));
  assert.equal(await new Vault(f.opts).restore(), KEY);
});
test('fresh nonce changes ciphertext; tampered cookies cannot override the encrypted backup', async () => {
  const {Vault} = setup(); const f = browserFixture(); const vault = new Vault(f.opts);
  await vault.save(KEY); const first = f.doc.cookie;
  await vault.save(KEY); assert.notEqual(f.doc.cookie, first);
  const token = f.doc.cookie; const index = token.length - 10;
  f.setCookie(token.slice(0,index) + (token[index] === 'A' ? 'B' : 'A') + token.slice(index + 1));
  assert.equal(await new Vault(f.opts).restore(), KEY);
  f.keys.set('https://c933103.github.io/molt/|ciphertext', f.doc.cookie.split('=')[1]);
  await assert.rejects(new Vault(f.opts).restore(), /could not be restored/);
});
test('disconnect removes cookie, session storage, backup and saved key, including a queued save racing with logout', async () => {
  const {Vault} = setup(); const f = browserFixture(); const vault = new Vault(f.opts);
  await vault.save(KEY); await vault.forget();
  assert.equal(f.doc.cookie, ''); assert.equal(f.keys.size, 0); assert.equal(f.sessionValues.size,0); assert.equal(await vault.restore(), null);
  const saving = vault.save(KEY); const forgetting = vault.forget();
  assert.equal(await saving, false); await forgetting;
  assert.equal(f.doc.cookie, ''); assert.equal(f.keys.size, 0); assert.equal(f.sessionValues.size,0);
});
test('cookie expiry requires neither manual reconnect nor renewal, even years later', async () => {
  const {Vault} = setup(); const f = browserFixture(); const vault = new Vault(f.opts);
  await vault.save(KEY); f.advance(5 * 365 * 24 * 60 * 60 * 1000); f.setCookie('');
  const writesBefore = f.writes.length;
  assert.equal(await new Vault(f.opts).restore(), KEY);
  assert.equal(f.writes.length, writesBefore); assert.equal(f.doc.cookie, '');
});
test('encrypted credentials cannot be replayed at a different Pages path', async () => {
  const {Vault} = setup(); const f = browserFixture(); await new Vault(f.opts).save(KEY);
  const another = new Vault({...f.opts, location:{href:'https://c933103.github.io/another/'}});
  await assert.rejects(another.restore(), /could not be restored/);
});
test('missing encryption keys and blocked browser storage never cause plaintext persistence', async () => {
  const {Vault} = setup(); const f = browserFixture(); await new Vault(f.opts).save(KEY); f.keys.clear();
  await assert.rejects(new Vault(f.opts).restore(), /could not be restored/);
  const broken = new Vault({...f.opts, indexedDB:{open() { throw new Error('Blocked'); }}});
  await assert.rejects(broken.save(KEY), /storage is unavailable/);
  assert.equal(f.writes.some(w => w.includes(KEY)), false);
});
test('HTTPS is required; encrypted browser persistence still works when cookies are blocked', async () => {
  const {Vault} = setup(); const f = browserFixture();
  assert.throws(() => new Vault({...f.opts, location:{href:'http://example.invalid/molt/'}}), /HTTPS/);
  const blockedCookies = {get cookie() { return ''; }, set cookie(_) {}};
  const blocked = new Vault({...f.opts, document:blockedCookies});
  assert.equal(await blocked.save(KEY), true);
  assert.equal(await new Vault({...f.opts, document:blockedCookies}).restore(), KEY);
});

test('stored envelope contains a real password-protected ZIP readable by Python zipfile', async () => {
  const {Vault,Zip} = setup(); const f = browserFixture(); await new Vault(f.opts).save(KEY);
  const scope = 'https://c933103.github.io/molt/';
  const bytes = Buffer.from(f.keys.get(scope + '|ciphertext').slice(3),'base64url');
  const archive = new Uint8Array(await webcrypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(0,12),additionalData:new TextEncoder().encode('Moltbook browser desk v2|' + scope),tagLength:128},f.keys.get(scope),bytes.subarray(12)));
  assert.equal(Zip.unpack(archive),KEY);
  assert.throws(() => Zip.unpack(archive,'124'),/password|damaged/);
  const independent = spawnSync('python3',['-c',[
    'import io, sys, zipfile',
    'z = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))',
    'assert z.namelist() == ["api-key.txt"]',
    'assert z.getinfo("api-key.txt").flag_bits & 1',
    'assert z.getinfo("api-key.txt").compress_type == zipfile.ZIP_STORED',
    'try:',
    '    z.read("api-key.txt")',
    'except RuntimeError:',
    '    pass',
    'else:',
    '    raise AssertionError("No password was required")',
    'try:',
    '    z.read("api-key.txt", pwd=b"124")',
    'except RuntimeError:',
    '    pass',
    'else:',
    '    raise AssertionError("Wrong password was accepted")',
    'sys.stdout.buffer.write(z.read("api-key.txt", pwd=b"123"))'
  ].join('\n')],{input:Buffer.from(archive),encoding:'utf8',timeout:5000});
  assert.equal(independent.status,0,independent.stderr); assert.equal(independent.stdout,KEY);
});

test('session storage restores the original authentication key when cookie and backup ciphertext are absent', async () => {
  let authorization;
  const {Vault,session} = setup(async (_,opts) => { authorization=opts.headers.Authorization; return response(); });
  const f = browserFixture(); await new Vault(f.opts).save(KEY);
  f.setCookie(''); f.keys.delete('https://c933103.github.io/molt/|ciphertext');
  const writesBefore = f.writes.length;
  session.disconnect(); session.connect(await new Vault(f.opts).restore()); await session.request('me');
  assert.equal(authorization,'Bearer ' + KEY);
  assert.equal(f.writes.length,writesBefore); assert.equal(f.doc.cookie,'');
});

test('a new tab gets its own session copy from persistent storage without cookie renewal', async () => {
  const {Vault} = setup(); const f = browserFixture(); await new Vault(f.opts).save(KEY);
  const writesBefore = f.writes.length; f.sessionValues.clear(); f.setCookie('');
  assert.equal(await new Vault(f.opts).restore(),KEY);
  assert.equal(f.sessionValues.size,1); assert.match([...f.sessionValues.values()][0],/^v2\./);
  assert.equal(f.writes.length,writesBefore); assert.equal(f.doc.cookie,'');
});

test('blocked session storage does not prevent persistent restore or expose plaintext', async () => {
  const {Vault} = setup(); const f = browserFixture();
  const denied = {getItem() { throw new Error('Denied'); },setItem() { throw new Error('Denied'); },removeItem() { throw new Error('Denied'); }};
  const vault = new Vault({...f.opts,sessionStorage:denied});
  assert.equal(await vault.save(KEY),true); assert.equal(await vault.restore(),KEY);
  assert.equal(f.sessionValues.size,0); assert.equal(f.writes.some(w => w.includes(KEY)),false);
  await assert.rejects(vault.forget(),/remove all saved copies/);
  assert.equal(f.doc.cookie,''); assert.equal(f.keys.size,0);
});

test('stale or damaged session data cannot override the saved key or resurrect it after logout', async () => {
  const {Vault} = setup(); const f = browserFixture(); const vault = new Vault(f.opts);
  await vault.save(KEY); const [name,oldToken] = [...f.sessionValues.entries()][0];
  const newer = KEY + '_updated'; await vault.save(newer);
  f.sessionValues.set(name,oldToken); assert.equal(await new Vault(f.opts).restore(),newer);
  f.sessionValues.set(name,'v2.' + 'A'.repeat(200)); assert.equal(await new Vault(f.opts).restore(),newer);
  f.keys.delete('https://c933103.github.io/molt/|ciphertext'); f.setCookie(''); f.sessionValues.set(name,'v2.' + 'A'.repeat(200));
  await assert.rejects(new Vault(f.opts).restore(),/could not be restored/);
  await vault.forget(); f.sessionValues.set(name,oldToken);
  await assert.rejects(new Vault(f.opts).restore(),/could not be restored/);
});

test('legacy connections upgrade to ZIP without cookie renewal or manual reconnection', async () => {
  const {Vault} = setup(); const f = browserFixture(); const scope = 'https://c933103.github.io/molt/';
  const key = await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('Moltbook browser desk v1|' + scope),tagLength:128},key,new TextEncoder().encode(JSON.stringify({key:KEY})));
  const token = 'v1.' + Buffer.concat([Buffer.from(iv),Buffer.from(ciphertext)]).toString('base64url');
  f.keys.set(scope,key); f.keys.set(scope + '|ciphertext',token); f.setCookie('__Secure-moltbook-desk-v1=' + token);
  const originalCookie = f.doc.cookie;
  assert.equal(await new Vault(f.opts).restore(),KEY);
  assert.match(f.keys.get(scope + '|ciphertext'),/^v2\./);
  assert.equal([...f.sessionValues.values()][0],f.keys.get(scope + '|ciphertext'));
  assert.equal(f.doc.cookie,originalCookie); assert.equal(f.writes.length,0);
  assert.equal(await new Vault(f.opts).restore(),KEY);
  // Also preserve old cookie-only connections whose wrapping key still exists.
  f.keys.delete(scope + '|ciphertext'); f.sessionValues.clear();
  assert.equal(await new Vault(f.opts).restore(),KEY); assert.equal(f.writes.length,0);
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

test('empty readable storage reports no saved connection without writes or requests', async () => {
  let calls = 0;
  const {Vault} = setup(() => { calls++; throw new Error('Unexpected network request'); });
  const f = browserFixture();
  assert.equal(await new Vault(f.opts).restore(),null);
  assert.equal(f.keys.size,0); assert.equal(f.writes.length,0); assert.equal(f.sessionValues.size,0); assert.equal(calls,0);
});

test('unavailable storage and crypto do not claim a saved credential exists or is damaged', async t => {
  const cases = [
    ['absent IndexedDB', f => { f.opts.indexedDB = null; }, /Browser credential storage is unavailable/],
    ['throwing IndexedDB', f => { f.opts.indexedDB = {open() { throw new Error(KEY); }}; }, /Browser credential storage is unavailable/],
    ['failed IndexedDB open', f => { f.opts.indexedDB = {open() { const req={}; setImmediate(() => req.onerror?.({message:KEY})); return req; }}; }, /Browser credential storage is unavailable/],
    ['blocked IndexedDB open', f => { f.opts.indexedDB = {open() { const req={}; setImmediate(() => req.onblocked?.({message:KEY})); return req; }}; }, /Browser credential storage is unavailable/],
    ['unavailable Web Crypto', f => { f.opts.crypto = {}; }, /Web Crypto is unavailable/],
    ['inaccessible cookie', f => { f.opts.document = {get cookie() { throw new Error(KEY); }}; }, /Browser credential storage is unavailable/]
  ];
  for (const [name,change,pattern] of cases) await t.test(name,async () => {
    let calls = 0;
    const {Vault} = setup(() => { calls++; throw new Error('Unexpected network request'); });
    const f = browserFixture(); change(f);
    await assert.rejects(new Vault(f.opts).restore(),err => {
      assert.match(err.message,pattern);
      assert.match(err.message,/Saved connection status could not be checked/);
      assert.match(err.message,/saved copies were not removed/i);
      assert.doesNotMatch(err.message,/saved credential could not be restored|Connect again|disconnect to remove/i);
      assert.equal(err.message.includes(KEY),false);
      return true;
    });
    assert.equal(f.keys.size,0); assert.equal(f.writes.length,0); assert.equal(f.sessionValues.size,0); assert.equal(calls,0);
  });
});

async function rejectsRestoreWithoutChangingCopies(Vault,f,pattern) {
  const keys = [...f.keys], session = [...f.sessionValues], cookie = f.doc.cookie, writes = [...f.writes];
  const forbidden = [KEY,...keys.map(([,value]) => value).filter(value => typeof value === 'string'),...session.map(([,value]) => value)];
  await assert.rejects(new Vault(f.opts).restore(),err => {
    assert.equal(err.name,'ClientError');
    assert.match(err.message,pattern); assert.match(err.message,/saved copies were not removed/i);
    for (const value of forbidden) if (value) assert.equal(err.message.includes(value),false);
    return true;
  });
  assert.deepEqual([...f.keys],keys); assert.deepEqual([...f.sessionValues],session);
  assert.equal(f.doc.cookie,cookie); assert.deepEqual(f.writes,writes);
}

test('unreadable session storage is not treated as absent when no other token can be read', async t => {
  for (const missing of [false,true]) await t.test(missing ? 'unavailable session API' : 'denied session read',async () => {
    const {Vault} = setup(); const f = browserFixture(); await new Vault(f.opts).save(KEY);
    f.keys.delete('https://c933103.github.io/molt/|ciphertext'); f.setCookie('');
    f.opts.sessionStorage = missing ? null : {
      getItem() { throw new Error(KEY); },
      setItem() { throw new Error(KEY); },
      removeItem() { throw new Error(KEY); }
    };
    await rejectsRestoreWithoutChangingCopies(Vault,f,/Browser credential storage is unavailable/);
  });
});

test('unreadable session storage still allows the existing cookie fallback', async () => {
  const {Vault} = setup(); const f = browserFixture(); await new Vault(f.opts).save(KEY);
  f.keys.delete('https://c933103.github.io/molt/|ciphertext');
  const cookie = f.doc.cookie, writes = [...f.writes], session = [...f.sessionValues];
  f.opts.sessionStorage = {getItem() { throw new Error(KEY); },setItem() { throw new Error(KEY); }};
  assert.equal(await new Vault(f.opts).restore(),KEY);
  assert.equal(f.doc.cookie,cookie); assert.deepEqual(f.writes,writes); assert.deepEqual([...f.sessionValues],session);
});

test('conflicting cookies receive cleanup guidance without disclosing or removing copies', async () => {
  const {Vault} = setup(); const f = browserFixture(); await new Vault(f.opts).save(KEY);
  const cookie = f.doc.cookie;
  f.keys.delete('https://c933103.github.io/molt/|ciphertext'); f.sessionValues.clear();
  f.setCookie(cookie + '; ' + cookie);
  await rejectsRestoreWithoutChangingCopies(Vault,f,/Conflicting saved credential cookies.*Forget saved key.*clear this site's cookies and storage/);
  await assert.rejects(new Vault(f.opts).restore(),err => {
    assert.doesNotMatch(err.message,/storage is unavailable|Reload to retry/);
    return true;
  });
});

test('conflicting cookies do not override an existing backup or session token', async () => {
  const {Vault} = setup(); const f = browserFixture(); await new Vault(f.opts).save(KEY);
  const cookie = f.doc.cookie; f.setCookie(cookie + '; ' + cookie);
  assert.equal(await new Vault(f.opts).restore(),KEY);
  f.keys.delete('https://c933103.github.io/molt/|ciphertext');
  assert.equal(await new Vault(f.opts).restore(),KEY);
  assert.equal(f.doc.cookie,cookie + '; ' + cookie);
});

test('restore distinguishes missing and invalid wrapping keys while retaining every copy', async t => {
  const scope = 'https://c933103.github.io/molt/';
  for (const invalid of [false,true]) await t.test(invalid ? 'invalid key' : 'missing key',async () => {
    const {Vault} = setup(); const f = browserFixture(); await new Vault(f.opts).save(KEY);
    if (invalid) f.keys.set(scope,{extractable:true}); else f.keys.delete(scope);
    await rejectsRestoreWithoutChangingCopies(Vault,f,invalid ? /encryption key is invalid/ : /encryption key is missing/);
  });
});

test('restore distinguishes malformed records, decryption failures and invalid ZIP contents', async t => {
  const scope = 'https://c933103.github.io/molt/';
  for (const stage of ['record','decryption','contents']) await t.test(stage,async () => {
    let calls = 0;
    const {Vault} = setup(() => { calls++; throw new Error('Unexpected network request'); });
    const f = browserFixture(); await new Vault(f.opts).save(KEY);
    if (stage === 'record') f.keys.set(scope + '|ciphertext','invalid-envelope-' + KEY);
    if (stage === 'decryption') {
      f.opts.crypto = {subtle:{decrypt() { throw new Error(KEY + f.keys.get(scope + '|ciphertext')); }}};
    }
    if (stage === 'contents') {
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('Moltbook browser desk v2|' + scope),tagLength:128},f.keys.get(scope),new Uint8Array(200));
      f.keys.set(scope + '|ciphertext','v2.' + Buffer.concat([Buffer.from(iv),Buffer.from(ciphertext)]).toString('base64url'));
    }
    const expected = {record:/encrypted record is invalid/,decryption:/decryption failed/,contents:/decrypted contents failed validation/}[stage];
    await rejectsRestoreWithoutChangingCopies(Vault,f,expected);
    assert.equal(calls,0);
  });
});

test('legacy migration failure is reported without renewing or removing the saved copies', async () => {
  const {Vault} = setup(); const f = browserFixture(); const scope = 'https://c933103.github.io/molt/';
  const key = await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('Moltbook browser desk v1|' + scope),tagLength:128},key,new TextEncoder().encode(JSON.stringify({key:KEY})));
  const token = 'v1.' + Buffer.concat([Buffer.from(iv),Buffer.from(ciphertext)]).toString('base64url');
  f.keys.set(scope,key); f.keys.set(scope + '|ciphertext',token); f.setCookie('__Secure-moltbook-desk-v1=' + token);
  f.opts.crypto = {
    getRandomValues:bytes => webcrypto.getRandomValues(bytes),
    subtle:{decrypt:(...args) => webcrypto.subtle.decrypt(...args), encrypt() { throw new Error(KEY + token); }}
  };
  await rejectsRestoreWithoutChangingCopies(Vault,f,/storage upgrade could not be completed/);
});

test('a transient storage failure can be retried with the existing saved copies', async () => {
  const {Vault} = setup(); const f = browserFixture(); await new Vault(f.opts).save(KEY);
  const working = f.opts.indexedDB; let blocked = true;
  f.opts.indexedDB = {open(...args) { if (blocked) throw new Error(KEY); return working.open(...args); }};
  const vault = new Vault(f.opts);
  await rejectsRestoreWithoutChangingCopies(Vault,f,/Browser credential storage is unavailable/);
  await assert.rejects(vault.restore(),/Browser credential storage is unavailable/);
  blocked = false;
  assert.equal(await vault.restore(),KEY);
});

test('disconnect still cancels a pending restore instead of surfacing a stale diagnostic', async () => {
  const {Vault} = setup(); const f = browserFixture(); await new Vault(f.opts).save(KEY);
  const working = f.opts.indexedDB; let failedOpen, pendingOpen = true;
  f.opts.indexedDB = {open(...args) {
    if (!pendingOpen) return working.open(...args);
    pendingOpen = false; failedOpen = {}; return failedOpen;
  }};
  const vault = new Vault(f.opts); const restoring = vault.restore();
  await new Promise(resolve => setImmediate(resolve));
  const forgetting = vault.forget(); failedOpen.onerror();
  assert.equal(await restoring,null); await forgetting;
  assert.equal(f.keys.size,0); assert.equal(f.doc.cookie,''); assert.equal(f.sessionValues.size,0);
});

test('external recovery archive restores authentication after every browser-stored copy is removed', async () => {
  let authorization;
  const {Vault,Zip,session} = setup(async (_,opts) => { authorization=opts.headers.Authorization; return response(); });
  const f = browserFixture(), vault = new Vault(f.opts); await vault.save(KEY);
  const portable = session.recoveryArchive(webcrypto);
  session.disconnect(); await vault.forget();
  assert.equal(f.doc.cookie,''); assert.equal(f.sessionValues.size,0); assert.equal(f.keys.size,0);
  assert.throws(() => session.recoveryArchive(webcrypto),/Connect this browser/);
  const recovered = Zip.unpack(portable,'123');
  session.connect(recovered); await session.request('me'); await new Vault(f.opts).save(recovered);
  assert.equal(authorization,'Bearer ' + KEY);
  assert.equal(await new Vault(f.opts).restore(),KEY);
  assert.equal(JSON.stringify(session).includes(KEY),false);
});

