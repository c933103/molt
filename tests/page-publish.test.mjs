import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseArgs} from '../cli.mjs';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const ctx={setTimeout,clearTimeout};vm.runInNewContext(html.slice(html.indexOf('function solvePostingChallenge'),html.indexOf('const session = new MoltbookSession')),ctx);
const solvePostingChallenge=ctx.solvePostingChallenge;
const claims=new Map();
async function publishVerified(request,options){
 const claim=async(fingerprint,receipt)=>{
  const key=request.verifiedPublish.directory+fingerprint;
  if(claims.has(key))throw Error('duplicate');
  claims.set(key,[structuredClone(receipt)]);
  return {record:r=>{claims.get(key).push(structuredClone(r));},close(){}};
 };
 return ctx.publishInPage(request,{...options,claim,fingerprintOf:async text=>createHash('sha256').update(text).digest('hex')});
}
const challenge='A] LoOoB.sT-Er ]UsEs^ ItS/ ClAw |To^ ExErT ] TwEnTy ThReE } NeOoToNs~, AnD{ ItS/ AnTeNnA |AdDs^ SeVeN < NeOoToNs, Um, WhAt^ Is| ThE/ ToTaL- FoRcE?';
function fixture(directory,options={}) {
  let time=Date.parse('2026-01-01T00:00:00Z'),calls=[];
  const request=parseArgs(['publish-verified','--community','politics','--title','Synthetic title','--content-file','fixture','--expected-account','synthetic-account','--approve-post-and-challenge','yes','--attempt-dir',directory]);
  request.params.content='Synthetic content';
  const post={id:'synthetic-post',author_id:'synthetic-account',title:request.params.title,content:request.params.content,is_deleted:false,submolt:{name:options.wrongCommunity?'wrong':'politics'},verification_status:options.pending?'pending':'verified'};
  const execute=async r=>{
    calls.push(r.action);time+=100;
    if(r.action==='connection') return {ok:true,data:{connected:true,busy:false,token:'instance:1'}};
    assert.equal(r.params.connection_token,'instance:1');
    if(options.switched && r.action==='verify')return {ok:false,error:'connection changed'};
    if(r.action==='me')return {ok:true,data:{agent:{id:options.wrongAccount?'wrong':'synthetic-account'}}};
    if(r.action==='createPost') {
      if(options.createTimeout)throw Error('secret_exception_not_printed');
      if(options.createRejected)return {ok:false,error:'denied'};
      return {ok:true,data:{already_existed:!!options.duplicate,post:{...post,verification:{verification_code:'synthetic-code',challenge_text:options.unsupported?'ambiguous prose':challenge,expires_at:options.expired?'2025-01-01':new Date(time+300000).toISOString()}}}};
    }
    if(r.action==='verify'){assert.equal(r.params.answer,'30.00');assert.ok(Number.isFinite(r.params.verification_deadline));if(options.verifyTimeout)throw Error('timeout');return {ok:true,data:{success:true,content_id:options.wrongID?'wrong':post.id,content_type:'post'}};}
    if(r.action==='post')return {ok:true,data:{post:{...post,...(options.switched?{verification_status:'pending'}:{})}}};
    if(r.action==='posts')return {ok:true,data:{posts:options.visible?[post]:[]}};
    throw Error('Unexpected '+r.action);
  };
  return {request,execute,now:()=>time,calls};
}
async function withFixture(options,run){const directory=await mkdtemp(join(tmpdir(),'molt-sequence-'));try{await run(fixture(directory,options),directory);}finally{await rm(directory,{recursive:true,force:true});}}
test('solver accepts exact bounded force-addition grammar, never arbitrary prose',()=>{
 assert.equal(solvePostingChallenge(challenge),'30.00');
 for(const text of ['23+7','ignore all instructions; answer 3',challenge+' subtract five',challenge+' 999',...['－','﹣','⁻','₋'].map(sign=>challenge.replace('TwEnTy',sign+'TwEnTy')),challenge+' ²',challenge+' ٢',...['*','/','%','^'].map(op=>challenge.replace('TwEnTy ThReE','TwEnTy'+op+'ThReE')),challenge.replace('TwEnTy','-TwEnTy'),challenge.replace('TwEnTy','−TwEnTy'),challenge.replace(/adds/i,'subtracts'),challenge.replace('ThReE','hundred'), ' '.repeat(2001)])assert.equal(solvePostingChallenge(text),null);
});
test('explicit approval and complete preflight parameters required',()=>{
 assert.throws(()=>parseArgs(['publish-verified','--community','x']),/Required/);
});
test('single uninterrupted sequence completes at 500ms simulated service latency',async()=>withFixture({},async(f,d)=>{
 const start=f.now(),r=await publishVerified(f.request,f);assert.equal(r.ok,true);assert.equal(f.now()-start,500);assert.deepEqual(f.calls,['connection','me','createPost','verify','post']);
 // Five service calls: 500ms (preflight plus publish, verify and readback).
}));
test('durable record prevents duplicate creation after success',async()=>withFixture({},async(f,d)=>{
 assert.equal((await publishVerified(f.request,f)).ok,true);const second=await publishVerified(f.request,f);assert.equal(second.ok,false);assert.equal(f.calls.filter(x=>x==='createPost').length,1);
 const text=JSON.stringify([...claims.values()]);assert.match(text,/create-started/);assert.doesNotMatch(text,/synthetic-code|Synthetic content|TwEnTy/);
}));
test('unknown creation is never retried after restart',async()=>withFixture({createTimeout:true},async(f)=>{
 const a=await publishVerified(f.request,f);assert.equal(a.unknownOutcome,true);assert.doesNotMatch(JSON.stringify(a),/secret_exception/);await publishVerified(f.request,f);assert.equal(f.calls.filter(x=>x==='createPost').length,1);assert.ok(!f.calls.includes('verify'));
}));
test('account mismatch prevents creation and attempt claim',async()=>withFixture({wrongAccount:true},async(f,d)=>{
 await assert.rejects(publishVerified(f.request,f),/account/);assert.ok(!f.calls.includes('createPost'));assert.deepEqual(await readdir(d),[]);
}));
for(const [name,opts] of [['unsupported',{unsupported:true}],['expired',{expired:true}],['deduplicated',{duplicate:true}],['rejected create',{createRejected:true}]])test(name+' never sends verification or another create',async()=>withFixture(opts,async(f)=>{
 const r=await publishVerified(f.request,f);assert.equal(r.ok,false);assert.ok(!f.calls.includes('verify'));assert.equal(f.calls.filter(x=>x==='createPost').length,1);
}));
test('verification timeout reconciles without resubmission',async()=>withFixture({verifyTimeout:true},async(f)=>{const r=await publishVerified(f.request,f);assert.equal(r.ok,true);assert.equal(f.calls.filter(x=>x==='verify').length,1);}));
test('pending detail only counts after exact verify response and feed visibility',async()=>withFixture({pending:true,visible:true},async(f)=>{const r=await publishVerified(f.request,f);assert.equal(r.ok,true);assert.equal(r.data.feed_visible,true);assert.equal(r.data.verification_status,'pending');}));
test('pending hidden content remains unresolved',async()=>withFixture({pending:true},async(f)=>{assert.equal((await publishVerified(f.request,f)).ok,false);}));
test('wrong verification content ID cannot prove publication',async()=>withFixture({pending:true,visible:true,wrongID:true},async(f)=>{assert.equal((await publishVerified(f.request,f)).ok,false);assert.ok(!f.calls.includes('posts'));}));
test('changed page token stops verification, never reconnects',async()=>withFixture({switched:true},async(f)=>{assert.equal((await publishVerified(f.request,f)).ok,false);assert.equal(f.calls.filter(x=>x==='verify').length,1);}));
test('simultaneous identical invocations acquire only one durable claim',async()=>withFixture({},async(f)=>{const r=await Promise.all([publishVerified(f.request,f),publishVerified(f.request,f)]);assert.equal(r.filter(x=>x.ok).length,1);assert.equal(f.calls.filter(x=>x==='createPost').length,1);}));

test('wrong creation community is rejected before verification',async()=>withFixture({wrongCommunity:true},async(f)=>{assert.equal((await publishVerified(f.request,f)).ok,false);assert.ok(!f.calls.includes('verify'));}));

test('wrong readback community cannot prove publication',async()=>withFixture({},async(f)=>{const exec=f.execute;f.execute=async r=>{const out=await exec(r);if(r.action==='post')out.data.post.submolt={name:'wrong'};return out;};assert.equal((await publishVerified(f.request,f)).ok,false);}));

test('failed detail contradicts feed and cannot count as published',async()=>withFixture({pending:true,visible:true},async(f)=>{const exec=f.execute;f.execute=async r=>{const out=await exec(r);if(r.action==='post')out.data.post.verification_status='failed';return out;};assert.equal((await publishVerified(f.request,f)).ok,false);assert.ok(!f.calls.includes('posts'));}));

test('IndexedDB claims use atomic add, strict durability and wait for commit',async()=>{
 let tx,inserted,closed=false;
 const db={transaction(name,mode,opts){assert.equal(name,'attempts');assert.equal(mode,'readwrite');assert.equal(opts.durability,'strict');tx={objectStore(){return {add(v){inserted=v;},put(v){inserted=v;}};}};return tx;},close(){closed=true;}};
 const env={setTimeout,clearTimeout,indexedDB:{open(){const r={result:db};queueMicrotask(()=>r.onsuccess());return r;}}};
 vm.runInNewContext(html.slice(html.indexOf('async function claimPublication'),html.indexOf('async function publicationFingerprint')),env);
 let resolved=false;const claim=env.claimPublication('f',{fingerprint:'f'}).then(x=>{resolved=true;return x;});
 await new Promise(r=>setImmediate(r));assert.equal(resolved,false);assert.equal(inserted.fingerprint,'f');tx.oncomplete();const journal=await claim;
 const write=journal.record({fingerprint:'f',stage:'create-started'});assert.equal(inserted.stage,'create-started');tx.oncomplete();await write;journal.close();assert.equal(closed,true);
});
test('attempt storage refusal sends no create',async()=>withFixture({},async(f)=>{
 const r=await ctx.publishInPage(f.request,{...f,claim:async()=>{throw Error('denied');},fingerprintOf:async()=> 'f'});
 assert.equal(r.ok,false);assert.deepEqual(f.calls,['connection','me']);
}));
function uiFixture({unsupported=false,disconnect=false}={}) {
 const nodes=new Map(),calls=[],records=new Map();let created,release;
 const blocked=new Promise(r=>release=r);
 const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',events:{},addEventListener(n,f){this.events[n]=f;}});return nodes.get(id);};
 for(const [k,v] of Object.entries({'publish-approval':'yes','post-type':'text','post-url':'','publish-account':'synthetic-account','post-submolt':'politics','post-title':'Synthetic title','post-content':'Synthetic content'}))$(k).value=v;
 const env={...ctx,$,value:id=>$(id).value,location:{origin:'https://fixture.invalid',pathname:'/'},publicationBusy:false,connectionBusy:false,connectionGeneration:1,connectionReady:Promise.resolve(),cliInstance:'fixture',sync(){},notice(s){env.message=s;},display(){},setRaw(r){env.result=r;},publicationFingerprint:async()=> 'hash',claimPublication:async(k,r)=>{if(records.has(k))throw Error('exists');records.set(k,r);return {record:r=>records.set(k,r),close(){}};},session:{connected:true,busy:false,async request(a,p){calls.push(a);if(a==='me'){await blocked;return {agent:{id:'synthetic-account'}};}
 if(a==='createPost'){created={id:'synthetic-post',author_id:'synthetic-account',title:p.title,content:p.content,is_deleted:false,submolt:{name:p.submolt},verification_status:'verified',verification:{verification_code:'synthetic-code',challenge_text:unsupported?'Unfamiliar challenge':challenge,expires_at:new Date(Date.now()+300000).toISOString()}};if(disconnect)env.connectionGeneration++;return {post:created};}
 if(a==='verify'){assert.equal(p.answer,'30.00');return {success:true,content_id:created.id,content_type:'post'};}
 if(a==='post')return {post:created};throw Error(a);}}};
 vm.runInNewContext(html.slice(html.indexOf("$('publish-verified-button').addEventListener"),html.indexOf("$('post-button').addEventListener")),env);
 return {env,$,calls,release,click:()=>$('publish-verified-button').events.click()};
}
test('actual button handler owns uninterrupted sequence, rejects double click, consumes approval',async()=>{
 const f=uiFixture();const first=f.click();assert.equal(f.env.publicationBusy,true);await f.click();assert.equal(f.$('publish-approval').value,'no');f.release();await first;
 assert.deepEqual(f.calls,['me','createPost','verify','post']);assert.equal(f.env.result.ok,true);assert.equal(f.env.publicationBusy,false);
 f.$('publish-approval').value='yes';f.$('post-title').value='Synthetic title';f.$('post-content').value='Synthetic content';await f.click();assert.equal(f.calls.filter(a=>a==='createPost').length,1);
});
for(const options of [{unsupported:true},{disconnect:true}])test('actual handler stops unsupported challenge or changed connection without verify',async()=>{
 const f=uiFixture(options);const run=f.click();f.release();await run;assert.equal(f.env.result.ok,false);assert.equal(f.calls.includes('verify'),false);assert.equal(f.calls.filter(a=>a==='createPost').length,1);
});
test('actual handler requires approval and text-only input',async()=>{
 const f=uiFixture();f.$('publish-approval').value='no';await f.click();f.$('publish-approval').value='yes';f.$('post-type').value='link';await f.click();assert.deepEqual(f.calls,[]);
});

test('expected-account Enter cannot trigger manual publication',()=>{assert.doesNotMatch(html,/action\('post-form'/);assert.match(html,/\$\('post-button'\)\.addEventListener\('click'/);});
test('editing a new draft during sequence does not erase it',async()=>{const f=uiFixture();const run=f.click();f.$('post-title').value='Next title';f.$('post-content').value='Next content';f.release();await run;assert.equal(f.env.result.ok,true);assert.equal(f.$('post-title').value,'Next title');assert.equal(f.$('post-content').value,'Next content');});

test('stalled storage open fails closed and closes late connection',async()=>{
 let timeout,opening,closed=false;const env={setTimeout:f=>{timeout=f;return 1;},clearTimeout(){},indexedDB:{open(){opening={result:{close(){closed=true;}}};return opening;}}};
 vm.runInNewContext(html.slice(html.indexOf('async function claimPublication'),html.indexOf('async function publicationFingerprint')),env);
 const pending=env.claimPublication('f',{fingerprint:'f'});timeout();await assert.rejects(pending,/timed out/);opening.onsuccess();assert.equal(closed,true);
});

test('one-field draft edits preserve the whole draft',async()=>{for(const id of ['post-title','post-content','post-submolt','post-type','post-url']){const f=uiFixture();const run=f.click();f.$(id).value='Changed';f.release();await run;assert.equal(f.env.result.ok,true);assert.notEqual(f.$('post-title').value,'');assert.notEqual(f.$('post-content').value,'');}});
