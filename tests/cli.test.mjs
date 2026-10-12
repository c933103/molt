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
  const request = parseArgs(['upvote','--id','post-123']);
  await assert.rejects(executeBrowser(request,{fetchImpl:async () => new Response(JSON.stringify(targets())), WebSocketImpl:Broken}), /Check the account before retrying/);
});
