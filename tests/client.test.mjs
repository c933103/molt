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
test('the page has a strict script hash, portable ZIP storage and no active forum HTML', () => {
  const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.ok(html.includes('sha256-' + createHash('sha256').update(script).digest('base64')));
  assert.match(html, /style-src 'none'/);
  assert.equal(html.includes('__CSP__'), false);
  assert.match(html, /connect-src https:\/\/www\.moltbook\.com/);
  assert.doesNotMatch(script, /\b(innerHTML|document\.write|eval|sendBeacon)\b/);
  assert.match(script, /globalThis\.localStorage/);
  assert.match(script, /CredentialZip\.unpack\(zip,'123'\)/);
  assert.doesNotMatch(script, /\b(indexedDB|sessionStorage|AES-GCM)\b|__Secure-moltbook-desk/);
  assert.doesNotMatch(html, /<script[^>]+src=|<img\b|<iframe\b/);
  new vm.Script(script);
});

// Test only the authorized portable ZIP storage and exact saved bytes.
function browserFixture() {
  const saved = new Map(), storageWrites = [];
  const localStorage = {
    getItem:id => saved.get(id) ?? null,
    setItem:(id,value) => { storageWrites.push([id,String(value)]); saved.set(id,String(value)); },
    removeItem:id => { storageWrites.push([id,null]); saved.delete(id); }
  };
  const opts = {crypto:webcrypto,location:{href:'https://c933103.github.io/molt/'},localStorage};
  return {saved,storageWrites,localStorage,opts};
}
const ZIP_NAME = 'moltbook-browser-desk-recovery-zip-v1|https://c933103.github.io/molt/';

test('persistent Base64 bytes are a standard password-123 ZIP readable by an independent ZIP implementation', async () => {
  const {Vault,Zip} = setup(); const f = browserFixture();
  assert.equal(await new Vault(f.opts).save(KEY),true);
  const encoded = f.saved.get(ZIP_NAME);
  assert.match(encoded,/^[A-Za-z0-9+/]+={0,2}$/);
  const bytes = Buffer.from(encoded,'base64');
  assert.equal(Zip.unpack(new Uint8Array(bytes)),KEY);
  assert.throws(() => Zip.unpack(new Uint8Array(bytes),'124'),/password|damaged/);
  const python = spawnSync('python3',['-c',[
    'import io,sys,zipfile',
    'z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))',
    'assert z.namelist()==["api-key.txt"]',
    'assert z.getinfo("api-key.txt").flag_bits & 1',
    'try: z.read("api-key.txt",pwd=b"124")',
    'except RuntimeError: pass',
    'else: raise AssertionError("wrong password accepted")',
    'sys.stdout.buffer.write(z.read("api-key.txt",pwd=b"123"))'
  ].join('\n')],{input:bytes,encoding:'utf8',timeout:5000});
  assert.equal(python.status,0,python.stderr); assert.equal(python.stdout,KEY);
  assert.equal(f.saved.size,1);
});
test('save can persist the exact caller-generated ZIP, not a separately randomized ZIP', async () => {
  const {Vault,Zip} = setup(); const f=browserFixture(), archive=Zip.pack(KEY,webcrypto);
  const original=Buffer.from(archive);
  assert.equal(await new Vault(f.opts).save(KEY,archive),true);
  assert.deepEqual(Buffer.from(f.saved.get(ZIP_NAME),'base64'),original);
  assert.deepEqual(Buffer.from(archive),original,'Caller owns the supplied archive until download');
  await assert.rejects(new Vault(f.opts).save(KEY+'_changed',archive),/does not match/);
  assert.deepEqual(Buffer.from(f.saved.get(ZIP_NAME),'base64'),original);
  archive.fill(0);
});
test('restart restores from only localStorage when AES, cookies, session and IndexedDB are unavailable', async () => {
  const {Vault} = setup(); const f=browserFixture();
  await new Vault(f.opts).save(KEY);
  let touched = 0;
  const restarted=new Vault({...f.opts,crypto:{},indexedDB:{open() {touched++;throw Error('legacy');}},sessionStorage:{getItem() {touched++;throw Error('legacy');}},document:{get cookie() {touched++;throw Error('legacy');}}});
  assert.equal(await restarted.restore(),KEY);
  assert.equal(touched,0);
});
test('credential rotation cannot restore stale credentials after persistent ZIP is lost', async () => {
  const {Vault} = setup(); const f=browserFixture(), vault=new Vault(f.opts);
  await vault.save(KEY);
  await vault.save(KEY+'_rotated');
  assert.equal(await new Vault(f.opts).restore(),KEY+'_rotated');
  f.saved.clear();
  assert.equal(await new Vault({...f.opts,indexedDB:{open() {throw Error('legacy');}}}).restore(),null);
});
test('corrupt or noncanonical Base64 ZIP is rejected without disclosure or overwriting existing copies', async () => {
  const {Vault} = setup(); const f=browserFixture(); await new Vault(f.opts).save(KEY);
  const original=f.saved.get(ZIP_NAME);
  for (const input of ['',KEY,original.slice(0,-4),original.replace(/.$/,'!'),Buffer.from('junk').toString('base64')]) {
    f.saved.set(ZIP_NAME,input);
    await assert.rejects(new Vault(f.opts).restore(),error=>/saved recovery ZIP is invalid/.test(error.message) && !error.message.includes(KEY));
    assert.equal(f.saved.get(ZIP_NAME),input);
  }
  f.saved.set(ZIP_NAME,original);
  assert.equal(await new Vault(f.opts).restore(),KEY);
});
test('forget removes the standalone ZIP and prevents pending saves from restoring it', async () => {
  const {Vault} = setup();const f=browserFixture(), vault=new Vault(f.opts);
  await vault.save(KEY); await vault.forget();
  assert.equal(f.saved.size,0); assert.equal(await vault.restore(),null);
  const saving=vault.save(KEY), forgetting=vault.forget();
  assert.equal(await saving,false); await forgetting;
  assert.equal(f.saved.size,0);
});
test('reentrant Forget while saving does not recreate a credential or claim saved', async () => {
  const {Vault} = setup(); const f=browserFixture(), vault=new Vault(f.opts);
  const put=f.localStorage.setItem; let forgotten;
  f.localStorage.setItem=(id,value)=>{put(id,value);forgotten=vault.forget();};
  assert.equal(await vault.save(KEY),false);
  await forgotten; assert.equal(f.saved.size,0);
});
test('unavailable localStorage gives sanitized error and retains the current connected tab', async () => {
  const {Vault} = setup();const f=browserFixture();
  const denied={getItem() {throw Error(KEY);},setItem(){throw Error(KEY);},removeItem(){throw Error(KEY);}};
  const vault=new Vault({...f.opts,localStorage:denied});
  await assert.rejects(vault.restore(),error=>/Browser persistent ZIP storage is unavailable/.test(error.message) && !error.message.includes(KEY));
  await assert.rejects(vault.save(KEY),error=>/could not save the recovery ZIP/.test(error.message) && !error.message.includes(KEY));
  await assert.rejects(vault.forget(),error=>/did not remove/.test(error.message) && !error.message.includes(KEY));
  assert.equal(f.saved.size,0);
});
test('missing localStorage, missing random generator and HTTP page fail safely', async () => {
  const {Vault} = setup();const f=browserFixture();
  assert.throws(()=>new Vault({...f.opts,location:{href:'http://example.invalid/molt/'}}),/HTTPS/);
  await assert.rejects(new Vault({...f.opts,localStorage:null}).restore(),/persistent ZIP storage is unavailable/);
  await assert.rejects(new Vault({...f.opts,localStorage:null}).save(KEY),/persistent ZIP storage is unavailable/);
  await assert.rejects(new Vault({...f.opts,crypto:{}}).save(KEY),/Web Crypto is unavailable/);
  assert.equal(f.saved.size,0);
});
test('ZIP parser rejects malformed, oversized, damaged and path-bearing archives', () => {
  const {Zip} = setup();const archive=Zip.pack(KEY,webcrypto);
  assert.equal(Zip.unpack(Zip.pack('Z'.repeat(512),webcrypto)),'Z'.repeat(512));
  assert.throws(()=>Zip.pack('Z'.repeat(513),webcrypto));
  for(const bad of [archive.slice(0,-1),new Uint8Array(10000),new Uint8Array(archive.length+1)]) assert.throws(()=>Zip.unpack(bad));
  for(const offset of [0,6,18,22,26,28,30,45,archive.length-22,archive.length-14]) {
    const bad=archive.slice();bad[offset]^=255;assert.throws(()=>Zip.unpack(bad));
  }
});
test('external ZIP recovery restores after all browser storage is erased', async () => {
  let authorization;const {Vault,Zip,session}=setup(async (_,opts)=>{authorization=opts.headers.Authorization;return response();});
  const f=browserFixture(),vault=new Vault(f.opts);
  await vault.save(KEY);
  const external=session.recoveryArchive(webcrypto);
  session.disconnect();await vault.forget();
  assert.equal(await vault.restore(),null);
  assert.throws(()=>session.recoveryArchive(webcrypto),/Connect this browser/);
  const key=Zip.unpack(external,'123');
  session.connect(key);await session.request('me');await vault.save(key);
  assert.equal(authorization,'Bearer '+KEY);
  assert.equal(await vault.restore(),KEY);
  assert.equal(JSON.stringify(session).includes(KEY),false);
  external.fill(0);
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
