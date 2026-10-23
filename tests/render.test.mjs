import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function fixture(source = html) {
  class Element {
    constructor(tag) { this.tagName=tag; this.children=[]; this.textContent=''; this.events={}; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children=items; }
    addEventListener(name,handler) { this.events[name]=handler; }
  }
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id,new Element('div')); return nodes.get(id); };
  const context = {$,document:{createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text})},MUTATIONS:new Set(),next:null,run(){throw Error('No requests allowed');},view(){},replyTo(){}};
  const start=source.indexOf('function node('),end=source.indexOf('function voteTarget(');
  vm.runInNewContext(source.slice(start,end),context);
  return {context,$};
}
const walk = element => [element,...(element.children || []).flatMap(walk)];
const click = (root,label) => { const b=walk(root).find(e=>e.tagName==='button'&&e.textContent===label); assert.ok(b,label); b.events.click(); };
const bodyText = body => body.children.map(n => n.tagName === 'br' ? '\n' : n.textContent).join('');
test('near-cap newline body stays bounded and all characters remain reachable', () => {
  const {context}=fixture();
  const text='\n'.repeat(900000)+'終😀<script>literal</script>';
  const tree=context.card({id:'p',content:text});
  const body=tree.children.find(e=>e.className==='body');
  let reconstructed=bodyText(body), maxNodes=0;
  while(walk(tree).some(e=>e.textContent==='Next text')) {
    click(tree,'Next text'); reconstructed+=bodyText(body); maxNodes=Math.max(maxNodes,walk(tree).length);
  }
  assert.equal(reconstructed,text); assert.ok(maxNodes<50);
  click(tree,'Previous text'); assert.ok(bodyText(body).length<=4096);
});
test('wide and deep replies, over 100 roots, previous navigation and API cursor are preserved', () => {
  const {context,$}=fixture();
  const comments=Array.from({length:121},(_,i)=>({id:'root'+i,content:'body',replies:[]}));
  comments[0].replies=Array.from({length:151},(_,i)=>({id:'child'+i,content:'child'}));
  let deep=comments[120]; for(let i=0;i<15;i++) { deep.replies=[{id:'deep'+i,content:'deep'}]; deep=deep.replies[0]; }
  context.display({comments,has_more:true,next_cursor:'cursor'},'comments',{id:'post'});
  const ids=[]; let maxNodes=0;
  do {
    const cards=$('results').children.filter(e=>e.className==='card');
    assert.ok(cards.length<=20); maxNodes=Math.max(maxNodes,walk($('results')).length);
    ids.push(...cards.map(e=>e.children.find(n=>n.className==='id').textContent));
    if(!walk($('results')).some(e=>e.textContent==='Next cards')) break;
    click($('results'),'Next cards');
  } while(true);
  assert.equal(ids.length,287); assert.equal(new Set(ids).size,287); assert.ok(maxNodes<600);
  assert.equal(context.next.params.cursor,'cursor'); assert.equal(context.next.action,'comments');
  click($('results'),'Previous cards'); assert.equal($('results').children.filter(e=>e.className==='card').length,20);
  context.display({posts:[{id:'new',content:'fresh'}]},'posts',{});
  assert.equal(context.next,null); assert.equal(walk($('results')).some(e=>e.textContent==='Previous cards'),false);
});
test('raw JSON is lazy, bounded, exactly reconstructable and reset on replacement', () => {
  const {context,$}=fixture(); let serialized=0;
  const data={content:'<literal>\n'.repeat(2500),toJSON(){serialized++;return {content:this.content};}};
  context.setRaw(data); assert.equal(serialized,0);
  $('raw-toggle').events.click(); assert.equal(serialized,1);
  let raw=$('raw-response').textContent;
  while(walk($('raw-controls')).some(e=>e.textContent==='Next text')) { click($('raw-controls'),'Next text'); assert.ok($('raw-response').textContent.length<=4096); raw+=$('raw-response').textContent; }
  assert.deepEqual(JSON.parse(raw),{content:data.content});
  $('raw-toggle').events.click(); assert.equal($('raw-response').textContent,'Raw response collapsed.');
  context.setRaw(undefined); $('raw-toggle').events.click(); assert.equal($('raw-response').textContent,'None');
});

test('text section boundaries do not split surrogate pairs', () => {
  const {context,$}=fixture();
  const text='x'.repeat(4095)+'😀'+'tail';
  context.textPages($('body'),text,$('controls'));
  assert.equal($('body').textContent,'x'.repeat(4095));
  click($('controls'),'Next text'); assert.equal($('body').textContent,'😀tail');
  click($('controls'),'Previous text'); assert.equal($('body').textContent,'x'.repeat(4095));
});

test('invalid entries cannot monopolize one local navigation step', () => {
  const {context,$}=fixture(); let reads=0;
  const entries = new Proxy(Array(1000).fill(null), {get(target,key) {if (/^[0-9]+$/.test(String(key))) reads++; return target[key];}});
  context.showCards(entries); assert.ok(reads<=200);
  assert.match($('results').children[0].textContent,/continue/);
  click($('results'),'Next cards'); assert.ok(reads<=400);
});

test('JSON null remains exact inspectable data rather than the cleared sentinel', () => {
  const {context,$}=fixture();
  context.display(null,'me',{});
  assert.equal($('raw-response').textContent,'Raw response collapsed.');
  $('raw-toggle').events.click(); assert.equal($('raw-response').textContent,'null');
  $('raw-toggle').events.click(); assert.equal($('raw-response').textContent,'Raw response collapsed.');
  $('raw-toggle').events.click(); assert.equal($('raw-response').textContent,'null');
  context.setRaw(undefined); $('raw-toggle').events.click();
  assert.equal($('raw-response').textContent,'None');
  assert.equal($('raw-controls').children.length,0);
});

test('paged long paragraphs retain native narrow-display wrapping without CSS', () => {
  const {context}=fixture();
  const text='A normal wrapping paragraph with spaces. '.repeat(400);
  const tree=context.card({id:'p',content:text});
  const body=tree.children.find(e=>e.className==='body');
  assert.equal(body.tagName,'div');
  assert.equal(body.children.some(e=>e.tagName==='pre'),false);
  assert.ok(bodyText(body).length<=4096);
  let all=bodyText(body);
  while(walk(tree).some(e=>e.textContent==='Next text')) {click(tree,'Next text'); all+=bodyText(body);}
  assert.equal(all,text);
  assert.doesNotMatch(html, /<style\b|\.style\b|white-space/);
});
test('wrapping bodies preserve CRLF boundaries, Unicode and bounded breaks across navigation', () => {
  const {context}=fixture();
  const text='a'.repeat(4095)+'\r\n'+'😀'+'\r\n'.repeat(40)+'tail';
  const tree=context.card({id:'p',content:text}), body=tree.children.find(e=>e.className==='body');
  const sections=[bodyText(body)];
  do {
    assert.ok(body.children.filter(e=>e.tagName==='br').length<=8);
    assert.ok(body.children.length<=17); assert.ok(bodyText(body).length<=4096);
    if(!walk(tree).some(e=>e.textContent==='Next text')) break;
    click(tree,'Next text'); sections.push(bodyText(body));
  } while(true);
  assert.equal(sections.join(''),text.replace(/\r\n/g,'\n'));
  for(let i=sections.length-2;i>=0;i--) {click(tree,'Previous text'); assert.equal(bodyText(body),sections[i]);}
});
test('twenty newline-heavy bodies remain globally node bounded', () => {
  const {context,$}=fixture();
  context.display({comments:Array.from({length:20},(_,i)=>({id:'c'+i,content:'\n'.repeat(10000)}))},'comments',{id:'p'});
  assert.equal($('results').children.filter(e=>e.className==='card').length,20);
  assert.ok(walk($('results')).length<1000);
});
