import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, webcrypto} from 'node:crypto';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const core = html.match(/\/\/ BEGIN CLIENT\n([\s\S]*?)\/\/ END CLIENT/)[1];
const KEY = 'moltbook_test_fixture_never_a_real_key';
function setup(fetchImpl) {
  const context = {fetch:fetchImpl, URL, URLSearchParams, AbortController, TextDecoder, TextEncoder, Uint8Array, btoa, atob, setTimeout, clearTimeout};
  vm.runInNewContext(core + '\nthis.Session = MoltbookSession; this.operation = operation; this.Vault = CredentialVault;', context);
  const session = new context.Session(); session.connect(KEY);
  return {session, operation:context.operation, Vault:context.Vault};
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
  assert.doesNotMatch(script, /\b(localStorage|sessionStorage|innerHTML|document\.write|eval|sendBeacon)\b/);
  assert.match(script, /generateKey\(\{name:'AES-GCM', length:256\}, false/);
  assert.match(script, /Max-Age=.*Secure; SameSite=Strict/);
  assert.doesNotMatch(html, /<script[^>]+src=|<img\b|<iframe\b/);
  new vm.Script(script);
});

// A deliberately small asynchronous IndexedDB fixture; no third-party dependencies.
// The real Web Crypto implementation performs every encrypt/decrypt operation.
function browserFixture() {
  const keys = new Map(), writes = []; let cookie = '', clock = Date.now();
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
  const opts = {document:doc, indexedDB:idb, crypto:webcrypto, location:{href:'https://c933103.github.io/molt/'}, now:() => clock};
  return {opts, keys, writes, doc, setCookie:v => { cookie = v; }, advance:ms => { clock += ms; }};
}
test('saved cookie and browser backup are encrypted; the wrapping key cannot be exported', async () => {
  const {Vault} = setup(); const f = browserFixture(); const vault = new Vault(f.opts);
  assert.equal(await vault.save(KEY), true);
  assert.equal(f.writes.some(w => w.includes(KEY)), false);
  assert.match(f.doc.cookie, /^__Secure-moltbook-desk-v1=v1\.[A-Za-z0-9_-]+$/);
  assert.match(f.writes[0], /Path=\/molt\/; Max-Age=34560000; Secure; SameSite=Strict$/);
  const key = [...f.keys.values()][0];
  assert.equal(key.extractable, false);
  assert.equal([...f.keys.values()].some(v => typeof v === 'string' && v.includes(KEY)), false);
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
test('disconnect removes both cookie and saved key, including a queued save racing with logout', async () => {
  const {Vault} = setup(); const f = browserFixture(); const vault = new Vault(f.opts);
  await vault.save(KEY); await vault.forget();
  assert.equal(f.doc.cookie, ''); assert.equal(f.keys.size, 0); assert.equal(await vault.restore(), null);
  const saving = vault.save(KEY); const forgetting = vault.forget();
  assert.equal(await saving, false); await forgetting;
  assert.equal(f.doc.cookie, ''); assert.equal(f.keys.size, 0);
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
