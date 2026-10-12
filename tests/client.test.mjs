import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const core = html.match(/\/\/ BEGIN CLIENT\n([\s\S]*?)\/\/ END CLIENT/)[1];
const KEY = 'moltbook_test_fixture_never_a_real_key';
function setup(fetchImpl) {
  const context = {fetch:fetchImpl, URL, URLSearchParams, AbortController, TextDecoder, setTimeout, clearTimeout};
  vm.runInNewContext(core + '\nthis.Session = MoltbookSession; this.operation = operation;', context);
  const session = new context.Session(); session.connect(KEY);
  return {session, operation:context.operation};
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
test('the published page has exact CSP hashes, no storage and no active forum HTML', () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  for (const text of [script, style]) assert.ok(html.includes('sha256-' + createHash('sha256').update(text).digest('base64')));
  assert.equal(html.includes('__CSP__'), false);
  assert.match(html, /connect-src https:\/\/www\.moltbook\.com/);
  assert.doesNotMatch(script, /\b(localStorage|sessionStorage|indexedDB|innerHTML|document\.write|eval|sendBeacon)\b/);
  assert.doesNotMatch(html, /<script[^>]+src=|<img\b|<iframe\b/);
  new vm.Script(script);
});
