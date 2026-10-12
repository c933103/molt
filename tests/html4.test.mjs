import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1];
test('HTML 4.0 markup has valid controls and labels and no CSS or HTML5 attributes', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('../check_html4.py',import.meta.url))], {encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.doesNotMatch(html, /<form\b/); // Password fields cannot fall back to native HTTP submission.
});
test('HTML 4.0 native buttons still connect, search and share the same credential with the CLI', async () => {
  const elements = new Map(), calls = [], KEY = 'moltbook_html4_fixture_not_a_real_key';
  class Element {
    constructor(tag,id = '') { this.tagName=tag.toUpperCase(); this.id=id; this.value=''; this.disabled=false; this.textContent=''; this.events={}; this.children=[]; }
    addEventListener(type,handler) { this.events[type]=handler; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children=children; }
    scrollIntoView() {}
    focus() {}
  }
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2],new Element(match[1],match[2]));
  const document = {
    getElementById:id => { assert.ok(elements.has(id),'Missing control: ' + id); return elements.get(id); },
    querySelectorAll:selector => { assert.equal(selector,'button'); return [...elements.values()].filter(e => e.tagName==='BUTTON'); },
    createElement:tag => { assert.ok(['button','p','h3','div','pre','br'].includes(tag)); return new Element(tag); },
    createTextNode:text => ({textContent:text})
  };
  const window = {addEventListener() {}};
  const context = {document,window,URL,URLSearchParams,AbortController,TextDecoder,TextEncoder,Uint8Array,btoa,atob,setTimeout,clearTimeout};
  context.fetch = async (url,options) => {
    calls.push({url,options});
    return new Response(JSON.stringify(url.includes('/search?') ? {success:true,results:[]} : {success:true,agent:{name:'Fixture'}}),{headers:{'content-type':'application/json'}});
  };
  vm.runInNewContext(script,context);
  elements.get('api-key').value=KEY;
  await elements.get('connect-button').events.click();
  assert.equal(elements.get('api-key').value,'');
  assert.equal(calls[0].url,'https://www.moltbook.com/api/v1/agents/me');
  assert.equal(calls[0].options.headers.Authorization,'Bearer ' + KEY);
  assert.equal((await window.moltbookDesk.execute('connection')).data.connected,true,elements.get('status').textContent);
  elements.get('query').value='railway information';
  await elements.get('search-button').events.click();
  assert.equal(calls.length,2,elements.get('status').textContent);
  assert.equal(new URL(calls[1].url).searchParams.get('q'),'railway information');
  const result = await window.moltbookDesk.execute('me');
  assert.equal(result.ok,true); assert.equal(calls[2].options.headers.Authorization,'Bearer ' + KEY);
  assert.equal(JSON.stringify(result).includes(KEY),false);
  assert.equal(Object.hasOwn(window.moltbookDesk,'key'),false);
});
