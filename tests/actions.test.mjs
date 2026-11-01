import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseArgs, requestExpression, DEFAULT_PAGE, executeBrowser} from '../cli.mjs';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const core = html.match(/\/\/ BEGIN CLIENT\n([\s\S]*?)\/\/ END CLIENT/)[1];
const KEY = 'moltbook_actions_fixture_not_real';
const response = (data = {success:true}, status = 200) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json'}});
const plain = x => JSON.parse(JSON.stringify(x));
function fixture(fetch = async () => response()) {
  const context = {fetch, URL, URLSearchParams, AbortController, TextDecoder, TextEncoder, Uint8Array, btoa, atob, setTimeout, clearTimeout};
  vm.runInNewContext(core + '\nthis.Session=MoltbookSession; this.operation=operation;', context);
  const session = new context.Session(); session.connect(KEY);
  return {...context, session};
}
test('all new remote controls use exact fixed endpoints, methods and bounded schemas', () => {
  const {operation} = fixture();
  const cases = [
    ['profile',{name:'Agent_1'},'/agents/profile?name=Agent_1','GET'],
    ['submolts',{},'/submolts','GET'],
    ['follow',{name:'Agent_1',confirm_target:'Agent_1'},'/agents/Agent_1/follow','POST'],
    ['unfollow',{name:'Agent_1',confirm_target:'Agent_1'},'/agents/Agent_1/follow','DELETE'],
    ['notifications',{},'/notifications?limit=15','GET'],
    ['notificationsRead',{confirm_target:'all'},'/notifications/read-all','POST'],
    ['dmCheck',{},'/agents/dm/check','GET'], ['dmRequests',{},'/agents/dm/requests','GET'],
    ['dmConversations',{},'/agents/dm/conversations?limit=20','GET'],
    ['dmConversation',{id:'c1'},'/agents/dm/conversations/c1','GET'],
    ['dmMessages',{id:'c1'},'/agents/dm/conversations/c1/messages?limit=25','GET'],
    ['dmSend',{id:'c1',confirm_target:'c1',message:'Hello'},'/agents/dm/conversations/c1/send','POST',{message:'Hello'}],
    ['dmNew',{name:'Agent_1',confirm_target:'Agent_1',message:'Hello'},'/agents/dm/conversations','POST',{recipient_name:'Agent_1',message:'Hello'}]
  ];
  for (const [action,params,path,method,body] of cases) {
    const op=operation(action,{...params,api_key:KEY,endpoint:'https://evil.invalid',body:{ignored:true}});
    assert.equal(op.url,'https://www.moltbook.com/api/v1'+path); assert.equal(op.method,method);
    assert.deepEqual(op.body === undefined ? undefined : plain(op.body),body);
  }
});
test('new mutations require explicit matching target and reject invalid identities before fetching', async () => {
  let calls=0; const {session}=fixture(async()=>{calls++;return response();});
  const cases=[['follow',{name:'agent'}],['unfollow',{name:'agent',confirm_target:'other'}],['notificationsRead',{}],['dmSend',{id:'c1',message:'Hi'}],['dmNew',{name:'agent',message:'Hi',confirm_target:'other'}]];
  for (const [action,p] of cases) await assert.rejects(session.request(action,p),/Confirm/);
  for (const name of ['../me','x/y','x%2Fy','x?name=me','', 'x'.repeat(81)]) {
    await assert.rejects(session.request('profile',{name}));
    await assert.rejects(session.request('follow',{name,confirm_target:name}));
    await assert.rejects(session.request('dmConversation',{id:name}));
  }
  for (const message of ['', 'x'.repeat(5001), KEY]) await assert.rejects(session.request('dmSend',{id:'c1',confirm_target:'c1',message}));
  await assert.rejects(session.request('dmNew',{name:KEY,confirm_target:KEY,message:'Hi'}));
  assert.equal(calls,0);
});
test('new pagination, following feed, search type and comment sort preserve encoded bounded values', () => {
  const {operation}=fixture(); const cursor='x&url=https://evil.invalid';
  for (const action of ['notifications','dmConversations','dmMessages']) {
    const u=new URL(operation(action,{id:'c1',limit:50,cursor}).url);
    assert.equal(u.searchParams.get('cursor'),cursor); assert.equal(u.searchParams.has('url'),false);
    for (const limit of [0,51,-1,1.5,'NaN']) assert.throws(()=>operation(action,{id:'c1',limit}));
    assert.throws(()=>operation(action,{id:'c1',cursor:'x'.repeat(4097)}));
  }
  assert.match(operation('feed',{sort:'rising',filter:'following',limit:100}).url,/sort=rising&limit=100&filter=following/);
  assert.throws(()=>operation('posts',{sort:'new',filter:'following'}));
  assert.throws(()=>operation('feed',{sort:'new',filter:'unknown'}));
  assert.match(operation('search',{q:'hi',type:'comments',limit:50}).url,/type=comments/);
  assert.throws(()=>operation('search',{q:'hi',type:'agents'}));
  assert.match(operation('comments',{id:'p1',sort:'old',limit:100}).url,/sort=old&limit=100/);
  assert.throws(()=>operation('comments',{id:'p1',sort:'top'}));
});
test('link/image posts validate a URL without loading media or accepting URL credentials', () => {
  const {operation}=fixture();
  for (const type of ['link','image']) {
    const body=operation('createPost',{submolt:'general',title:'Title',content:'',type,url:'https://example.invalid/story'}).body;
    assert.equal(body.type,type); assert.equal(body.url,'https://example.invalid/story');
    for (const url of ['javascript:alert(1)','data:text/html,x','file:///tmp/x','https://user:pass@example.invalid/','']) assert.throws(()=>operation('createPost',{submolt:'general',title:'Title',content:'',type,url}));
  }
  assert.throws(()=>operation('createPost',{submolt:'general',title:'Title',content:'body',type:'video'}));
});
test('compatibility DM responses are labeled, sanitized, and never retried or rerouted', async () => {
  const calls=[]; const {session}=fixture(async (url,opts)=>{calls.push({url,opts});return response({message:KEY,api_key:KEY,has_more:true,next_cursor:'next'});});
  const result=await session.request('dmMessages',{id:'c1'});
  assert.equal(result.contract,'unverified_compatibility'); assert.equal(result.response.next_cursor,'next');
  assert.equal(JSON.stringify(result).includes(KEY),false);
  assert.equal(calls.length,1); assert.equal(calls[0].opts.credentials,'omit'); assert.equal(calls[0].opts.redirect,'error');
  let failedCalls=0; const failed=fixture(async()=>{failedCalls++;throw new Error('transport');});
  await assert.rejects(failed.session.request('dmSend',{id:'c1',confirm_target:'c1',message:'Hello'}),e=>e.unknownOutcome);
  assert.equal(failedCalls,1);
  const rejected=fixture(async()=>{failedCalls++;return response({success:false,error:'Not supported'},404);});
  await assert.rejects(rejected.session.request('dmNew',{name:'agent',confirm_target:'agent',message:'Hello'}),e=>!e.unknownOutcome && /404/.test(e.message));
  assert.equal(failedCalls,2);
});
test('consequential new actions classify lost and server-error outcomes, and support empty responses', async () => {
  const cases=[['follow',{name:'agent',confirm_target:'agent'}],['unfollow',{name:'agent',confirm_target:'agent'}],['notificationsRead',{confirm_target:'all'}],['dmNew',{name:'agent',confirm_target:'agent',message:'Hello'}]];
  for (const [action,p] of cases) {
    const failed=fixture(async()=>response({error:'failed'},503));
    await assert.rejects(failed.session.request(action,p),e=>e.unknownOutcome);
    const empty=fixture(async()=>new Response(null,{status:204}));
    const data=await empty.session.request(action,p); assert.equal((data.response||data).http_status,204);
  }
});
test('DM send snapshots target and content, serializes requests and invalidates disconnected responses', async () => {
  let release, sent; const {session}=fixture((url,opts)=>{sent={url,opts};return new Promise(r=>release=r);});
  const p={id:'c1',confirm_target:'c1',message:'Original'}; const pending=session.request('dmSend',p);
  p.id='other';p.message='Changed';
  await assert.rejects(session.request('dmCheck'),/already running/);
  assert.equal(sent.url,'https://www.moltbook.com/api/v1/agents/dm/conversations/c1/send'); assert.equal(JSON.parse(sent.opts.body).message,'Original');
  session.disconnect();release(response());await assert.rejects(pending,e=>e.unknownOutcome&&/discarded/.test(e.message));
});
test('state is bounded, contains no content, is a defensive copy and clears on account changes', async () => {
  const {session}=fixture(async url=>response({post:{id:new URL(url).pathname.split('/').pop(),comment_count:2,content:'private_content'}}));
  for(let i=0;i<205;i++) await session.request('post',{id:'p'+i});
  const state=await session.request('state',{fmt:'full'});
  assert.equal(state.tracked_posts,200);assert.equal(state.posts[0].post_id,'p5');assert.equal(JSON.stringify(state).includes('private_content'),false);
  state.posts[0].comment_count=999;assert.equal((await session.request('state',{fmt:'full'})).posts[0].comment_count,2);
  session.disconnect();session.connect(KEY);assert.equal((await session.request('state')).tracked_posts,0);
  await assert.rejects(session.request('state',{fmt:'invalid'}));
});
test('thread diff is explicitly invoked, caps at 15, tracks signed changes and reports failed checks', async () => {
  const calls=[];let checking=false;
  const {session}=fixture(async url=>{const id=new URL(url).pathname.split('/').pop();calls.push(id);if(checking&&id==='p18')return response({error:'missing'},404);return response({post:{id,comment_count:checking?(id==='p17'?1:4):2}});});
  for(let i=0;i<20;i++) await session.request('post',{id:'p'+i});
  assert.equal((await session.request('threadDiff')).selected,0);assert.equal(calls.length,20);
  checking=true;const diff=await session.request('threadDiff',{scope:'all'});
  assert.equal(diff.selected,15);assert.equal(diff.checked,14);assert.equal(diff.failures.length,1);assert.equal(diff.failures[0].post_id,'p18');
  assert.equal(diff.updates.find(p=>p.post_id==='p17').delta,-1);assert.equal(calls.length,35);
  const again=await session.request('threadDiff',{scope:'all'});assert.equal(again.updates.length,0);
  await assert.rejects(session.request('threadDiff',{scope:'unknown'}));
});
test('engaged thread checks require a known baseline and reject mismatched response identity', async () => {
  let count=2, wrong=false;const calls=[];
  const {session}=fixture(async url=>{calls.push(url);return response(url.endsWith('/comments')?{comment:{id:'c1'}}:{post:{id:wrong?'different':'p1',comment_count:count}});});
  await session.request('comment',{id:'p1',content:'Synthetic'});
  assert.equal((await session.request('threadDiff')).selected,0);
  await session.request('post',{id:'p1'});count=3;
  assert.equal((await session.request('threadDiff')).updates[0].delta,1);
  wrong=true;const diff=await session.request('threadDiff');assert.equal(diff.checked,0);assert.equal(diff.failures.length,1);
  assert.equal((await session.request('state',{fmt:'full'})).posts[0].comment_count,3);
});
test('post vote guards do not copy toggle semantics and survive uncertain outcomes and reconnect', async () => {
  let calls=0;const {session}=fixture(async()=>{calls++;throw new Error('lost');});
  await assert.rejects(session.request('upvote',{id:'p1'}),e=>e.unknownOutcome);
  await assert.rejects(session.request('downvote',{id:'p1'}),/already attempted/);
  session.disconnect();session.connect(KEY);await assert.rejects(session.request('upvote',{id:'p1',force:true}),/already attempted/);
  assert.equal(calls,1);
  let rejects=0;const rejected=fixture(async()=>{rejects++;return response({error:'no'},403);});
  await assert.rejects(rejected.session.request('upvote',{id:'p1'}));await assert.rejects(rejected.session.request('upvote',{id:'p1'}));assert.equal(rejects,2);
});
test('CLI exposes every new control with exact aliases and mutation confirmations', () => {
  const cases=[['profile','--name','Agent'],['submolts'],['follow','--name','Agent','--confirm-target','Agent'],['unfollow','--name','Agent','--confirm-target','Agent'],['notifications'],['notifications-read','--confirm-target','all'],['dm-check'],['dm-requests'],['dm-conversations'],['dm-conversation','--id','c1'],['dm-messages','--id','c1'],['dm-send','--id','c1','--message-file','message.txt','--confirm-target','c1'],['dm-new','--name','Agent','--message-file','message.txt','--confirm-target','Agent'],['state','--format','full'],['thread-diff','--scope','all']];
  for(const args of cases){const r=parseArgs(args);assert.doesNotThrow(()=>requestExpression(r.action,r.params,new URL(DEFAULT_PAGE)));}
  assert.equal(parseArgs(cases[11]).messageFile,'message.txt');
  for(const args of [['follow','--name','Agent'],['notifications-read','--confirm-target','other'],['dm-send','--id','c1','--message-file','message.txt','--confirm-target','other']])assert.throws(()=>parseArgs(args));
  assert.deepEqual(parseArgs(['feed','--sort','rising','--filter','following','--limit','50']).params,{sort:'rising',limit:'50',filter:'following'});
  assert.equal(parseArgs(['comments','--id','p1','--sort','best']).params.sort,'best');
});

function pageFixture() {
  const elements=new Map(), calls=[];
  class Element {
    constructor(tag){this.tagName=tag.toUpperCase();this.value='';this.textContent='';this.children=[];this.events={};}
    addEventListener(type,fn){this.events[type]=fn;} append(...c){this.children.push(...c);} replaceChildren(...c){this.children=c;} scrollIntoView(){} focus(){}
  }
  for(const m of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g))elements.set(m[2],new Element(m[1]));
  const document={getElementById:id=>elements.get(id),querySelectorAll:()=>[...elements.values()].filter(e=>e.tagName==='BUTTON'),createElement:t=>new Element(t),createTextNode:t=>({textContent:t})};
  const window={addEventListener(){}};
  const context={document,window,URL,URLSearchParams,AbortController,TextDecoder,TextEncoder,Uint8Array,Blob,btoa,atob,setTimeout,clearTimeout,fetch:async(url,opts)=>{calls.push({url,opts});return response({has_more:true,next_cursor:'next',messages:[{message:'Hi'}]});}};
  const script=html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1].replace('const session = new MoltbookSession();','const session = new MoltbookSession(); globalThis.testSession = session;');
  vm.runInNewContext(script,context);context.testSession.connect(KEY);
  return {elements,calls,window};
}
test('UI prepares an exact DM, does not submit on Enter, invalidates edits/cancel and confirms only once', async () => {
  const {elements:e,calls}=pageFixture();
  e.get('more-action').value='dmSend';e.get('more-target').value='c1';e.get('more-message').value='Hello';
  await e.get('more-prepare').events.click();assert.equal(calls.length,0);assert.match(e.get('more-preview').textContent,/Hello/);assert.equal(e.get('more-confirm').disabled,false);
  assert.equal(e.get('more-form').events.keydown,undefined);
  e.get('more-form').events.input();await e.get('more-confirm').events.click();assert.equal(calls.length,0);
  await e.get('more-prepare').events.click();e.get('more-cancel').events.click();await e.get('more-confirm').events.click();assert.equal(calls.length,0);
  await e.get('more-prepare').events.click();await e.get('more-confirm').events.click();await e.get('more-confirm').events.click();assert.equal(calls.length,1);assert.equal(JSON.parse(calls[0].opts.body).message,'Hello');
});
test('UI disconnect cancels pending mutations and DM pagination keeps exact compatibility action', async () => {
  const {elements:e,calls,window}=pageFixture();
  e.get('more-action').value='follow';e.get('more-target').value='Agent';await e.get('more-prepare').events.click();
  await e.get('disconnect').events.click();await e.get('more-confirm').events.click();assert.equal(calls.length,0);
  const f=pageFixture();const result=await f.window.moltbookDesk.execute('dmMessages',{id:'c1',limit:10});assert.equal(result.data.contract,'unverified_compatibility');
  await f.elements.get('next-page').events.click();assert.equal(f.calls.length,2);assert.match(f.calls[1].url,/conversations\/c1\/messages\?limit=10&cursor=next/);
});

test('lost CLI response classifies all new writes as uncertain without retrying', async () => {
  const commands=[['follow','--name','Agent','--confirm-target','Agent'],['unfollow','--name','Agent','--confirm-target','Agent'],['notifications-read','--confirm-target','all'],['dm-send','--id','c1','--message-file','m.txt','--confirm-target','c1'],['dm-new','--name','Agent','--message-file','m.txt','--confirm-target','Agent']];
  for(const args of commands){
    let writes=0;
    class Broken {
      handlers={}; constructor(){setImmediate(()=>this.handlers.open?.({}));}
      addEventListener(type,fn){this.handlers[type]=fn;} send(){writes++;setImmediate(()=>this.handlers.close?.({}));} close(){}
    }
    await assert.rejects(executeBrowser(parseArgs(args),{fetchImpl:async()=>new Response(JSON.stringify([{id:'t',type:'page',url:DEFAULT_PAGE,webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/t'}])),WebSocketImpl:Broken}),/may have reached Moltbook/);
    assert.equal(writes,1);
  }
});
