import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseArgs, loopbackEndpoint, pageURL, selectTarget, socketURL, requestExpression, executeBrowser} from '../cli.mjs';

test('CLI parses read and write operations without accepting an API key', () => {
  const read = parseArgs(['posts','--sort','hot','--community','general']);
  assert.deepEqual(read.params,{sort:'hot',submolt:'general'});
  const write = parseArgs(['publish','--community','general','--title','Title','--content-file','body.txt']);
  assert.equal(write.action,'createPost'); assert.equal(write.contentFile,'body.txt');
  assert.throws(() => parseArgs(['me','--api-key','secret']), /Unknown/);
  assert.throws(() => parseArgs(['cookie']), /Unknown/);
  assert.throws(() => parseArgs(['publish','--title','Title']), /Required/);
});
test('debugging endpoints and sockets are restricted to the selected loopback origin', () => {
  for (const url of ['http://evil.invalid:9222','http://localhost:9222','https://127.0.0.1:9222','http://user:pass@127.0.0.1:9222','http://127.0.0.1:9222/other','http://127.0.0.1:9222/?url=remote']) assert.throws(() => loopbackEndpoint(url));
  const endpoint = loopbackEndpoint();
  assert.equal(socketURL('ws://127.0.0.1:9222/devtools/page/fixture',endpoint).hostname,'127.0.0.1');
  for (const url of ['ws://evil.invalid:9222/devtools/page/x','ws://127.0.0.1:1234/devtools/page/x','ws://127.0.0.1:9222/devtools/browser/x']) assert.throws(() => socketURL(url,endpoint));
});
test('CLI delete requires matching target confirmation and serializes only the bounded operation', async () => {
  assert.throws(() => parseArgs(['delete','--id','post-123']),/Required/);
  assert.throws(() => parseArgs(['delete','--id','post-123','--confirm-id','other']),/same post ID/);
  const request=parseArgs(['delete','--id','post-123','--confirm-id','post-123']);
  assert.equal(request.action,'deletePost');
  assert.deepEqual(request.params,{id:'post-123',confirm_id:'post-123'});
  const page=pageURL(); let called;
  const context={location:{origin:page.origin,pathname:page.pathname,search:'',hash:''},window:{moltbookDesk:{version:1,async execute(action,params) { called={action,params}; return {ok:true,data:{success:true}}; }}}};
  await vm.runInNewContext(requestExpression(request.action,request.params,page),context);
  assert.equal(called.action,'deletePost'); assert.equal(called.params.confirm_id,'post-123');
});
test('only the exact requested page is selected; duplicate tabs require a selection', () => {
  const page = pageURL();
  const one = {id:'one',type:'page',url:page.href};
  const other = {id:'other',type:'page',url:'https://c933103.github.io/another/'};
  assert.equal(selectTarget([one,other],page).id,'one');
  assert.throws(() => selectTarget([one,{...one,id:'two'}],page), /More than one/);
  assert.equal(selectTarget([one,{...one,id:'two'}],page,'two').id,'two');
  assert.throws(() => selectTarget([other],page), /Open the client/);
});
test('command content cannot escape its serialized parameters or execute source code', async () => {
  const page = pageURL(); let called;
  const q = '"}); globalThis.compromised=true; // <script> \\ $()';
  const context = {location:{origin:page.origin,pathname:page.pathname,search:'',hash:''},window:{moltbookDesk:{version:1,async execute(action,params) { called={action,params}; return {ok:true,data:{count:1}}; }}}};
  const result = await vm.runInNewContext(requestExpression('search',{q},page),context);
  assert.equal(result.ok,true); assert.equal(called.params.q,q); assert.equal(context.compromised,undefined);
  context.location.pathname='/another/'; called=null;
  const changed = await vm.runInNewContext(requestExpression('me',{},page),context);
  assert.equal(changed.ok,false); assert.equal(called,null);
});
function fakeSocket(callback) {
  return class {
    handlers = {};
    constructor(url) { this.url=url; setImmediate(() => this.handlers.open?.({})); }
    addEventListener(type,handler) { this.handlers[type]=handler; }
    send(text) { callback(JSON.parse(text),response => setImmediate(() => this.handlers.message?.({data:JSON.stringify(response)}))); }
    close() {}
  };
}
function targets() { return [{id:'fixture',type:'page',url:pageURL().href,webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/fixture'}]; }
test('CLI uses browser operations and neither retrieves cookies nor sends Moltbook authorization headers', async () => {
  const request = parseArgs(['me']); let fetches=0, commands=0;
  const result = await executeBrowser(request,{
    fetchImpl:async (url,opts) => { fetches++; assert.equal(url.href,'http://127.0.0.1:9222/json/list'); assert.equal(opts.redirect,'error'); assert.equal(opts.headers,undefined); return new Response(JSON.stringify(targets())); },
    WebSocketImpl:fakeSocket((command,respond) => { commands++; assert.equal(command.method,'Runtime.evaluate'); assert.equal(command.params.awaitPromise,true); assert.equal(command.params.returnByValue,true); assert.doesNotMatch(command.params.expression,/document\.cookie|indexedDB|Authorization|api_key/); respond({id:1,result:{result:{value:{ok:true,data:{name:'Fixture'}}}}}); })
  });
  assert.deepEqual(result,{ok:true,data:{name:'Fixture'}}); assert.equal(fetches,1); assert.equal(commands,1);
});
test('browser rejection is returned without automatic retry', async () => {
  let commands=0;
  const result = await executeBrowser(parseArgs(['comment','--id','post-123','--content-file','body.txt']),{
    fetchImpl:async () => new Response(JSON.stringify(targets())),
    WebSocketImpl:fakeSocket((command,respond) => { commands++; respond({id:1,result:{result:{value:{ok:false,error:'Connect this browser first.'}}}}); })
  });
  assert.equal(result.ok,false); assert.equal(commands,1);
});
test('lost browser response after a write is reported as an unknown outcome, not retried', async () => {
  const Broken = class {
    handlers = {};
    constructor() { setImmediate(() => this.handlers.open?.({})); }
    addEventListener(type,handler) { this.handlers[type]=handler; }
    send() { setImmediate(() => this.handlers.close?.({})); }
    close() {}
  };
  for (const args of [['upvote','--id','post-123'],['delete','--id','post-123','--confirm-id','post-123']]) {
    await assert.rejects(executeBrowser(parseArgs(args),{fetchImpl:async () => new Response(JSON.stringify(targets())), WebSocketImpl:Broken}), /Check the account before retrying/);
  }
});


test('comment commands keep comment identity separate from parent and do not accept arbitrary requester IDs', async () => {
  const vote=parseArgs(['comment-upvote','--id','reply-123','--post-id','parent-456']);
  assert.equal(vote.action,'commentUpvote'); assert.deepEqual(vote.params,{id:'reply-123',post_id:'parent-456'});
  const read=parseArgs(['comment-readback','--id','parent-456','--cursor','cursor?x=1']);
  assert.equal(read.action,'commentReadback'); assert.deepEqual(read.params,{id:'parent-456',cursor:'cursor?x=1'});
  assert.throws(()=>parseArgs(['comment-upvote']),/Required/);
  assert.throws(()=>parseArgs(['comment-readback','--id','parent','--requester-id','other']),/Unknown/);
  assert.throws(()=>parseArgs(['comment-downvote','--id','reply']),/Required/);
  const page=pageURL(); let called;
  const context={location:{origin:page.origin,pathname:page.pathname,search:'',hash:''},window:{moltbookDesk:{version:1,async execute(action,params) { called={action,params}; return {ok:true,data:{type:'comment_vote'}}; }}}};
  await vm.runInNewContext(requestExpression(vote.action,vote.params,page),context);
  assert.equal(called.action,'commentUpvote'); assert.equal(called.params.id,'reply-123'); assert.equal(called.params.post_id,'parent-456');
  await vm.runInNewContext(requestExpression(read.action,read.params,page),context);
  assert.equal(called.action,'commentReadback'); assert.equal(called.params.id,'parent-456');
});

test('lost comment-upvote browser response is classified as an uncertain write without retry', async () => {
  let writes=0;
  const Broken=class {
    handlers={};
    constructor() { setImmediate(()=>this.handlers.open?.({})); }
    addEventListener(type,handler) { this.handlers[type]=handler; }
    send() { writes++; setImmediate(()=>this.handlers.close?.({})); }
    close() {}
  };
  await assert.rejects(executeBrowser(parseArgs(['comment-upvote','--id','reply']),{
    fetchImpl:async ()=>new Response(JSON.stringify(targets())),WebSocketImpl:Broken
  }),/may have reached Moltbook/);
  assert.equal(writes,1);
});

test('comment removal CLI requires exact confirmation and parent context', () => {
  const args=['comment-remove-upvote','--id','reply','--post-id','parent','--confirm-id','reply'];
  const result=parseArgs(args); assert.equal(result.action,'commentRemoveUpvote');
  assert.deepEqual(result.params,{id:'reply',post_id:'parent',confirm_id:'reply'});
  assert.throws(()=>parseArgs(args.slice(0,-2)),/Required/);
  assert.throws(()=>parseArgs([...args.slice(0,-1),'other']),/same comment ID/);
  assert.throws(()=>parseArgs([...args,'--requester-id','other']),/Unknown/);
});

test('comment downvote CLI requires an exact independently authorized target',()=>{
  const args=['comment-downvote','--id','reply','--post-id','parent','--confirm-id','reply'];
  const result=parseArgs(args);assert.equal(result.action,'commentDownvote');assert.deepEqual(result.params,{id:'reply',post_id:'parent',confirm_id:'reply'});
  assert.throws(()=>parseArgs(args.slice(0,-2)),/Required/);assert.throws(()=>parseArgs([...args.slice(0,-1),'other']),/same comment ID/);assert.throws(()=>parseArgs([...args,'--requester-id','other']),/Unknown/);
});
