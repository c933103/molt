import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html',import.meta.url),'utf8');
const core = html.match(/\/\/ BEGIN CLIENT\n([\s\S]*?)\/\/ END CLIENT/)[1];
const context = {TextEncoder,TextDecoder,Uint8Array,DecompressionStream,ReadableStream};
vm.runInNewContext(core+'\nthis.Zip = CredentialZip;',context);
const Zip = context.Zip;
const KEY = 'moltbook_recovery_fixture_never_a_real_key_'+'x'.repeat(160);
// Independent Info-ZIP 3.0 fixtures, made with zip -9/-0 -P PASSWORD and
// api-key.txt containing KEY + CRLF. Includes metadata and data descriptors.
const DEFLATED = 'UEsDBBQACwAIAC0IZl1OFAZEPAAAAM0AAAALABwAYXBpLWtleS50eHRVVAkAA+Ym7WrmJu1qdXgLAAEE6AMAAAToAwAAg2sFpTiEbTllmjO+47Iyb2tCyoUmgJu0E2lJI+NioxT1Ex8rMO5U29m4idi0DF9d+w3YNUW2VreiJoiKUEsHCE4UBkQ8AAAAzQAAAFBLAQIeAxQACwAIAC0IZl1OFAZEPAAAAM0AAAALABgAAAAAAAEAAACkgQAAAABhcGkta2V5LnR4dFVUBQAD5ibtanV4CwABBOgDAAAE6AMAAFBLBQYAAAAAAQABAFEAAACRAAAAAAA=';
const STORED = 'UEsDBAoACQAAAC0IZl1OFAZE2QAAAM0AAAALABwAYXBpLWtleS50eHRVVAkAA+Ym7WrnJu1qdXgLAAEE6AMAAAToAwAAff0HJZkoaQMKnB5gH79UzIWSYuOAOhHgQG7NPeAQN7qd4ALCuZFGtsr7BfmNMff4Sq7lGggKjY/vEAHEZ3eyjBYBGq98tEjh1kmlqnfaXlqYROBhoBfQqU8n8US8BfeK8qKqyJ+wXEQ0WPJgBXrLeRGhv8B7SIny3KKzbMQByOj9nQrinkxZOUPM1ThNssELToivWTdeTJwt7PEPct4UVL4q1tdyQDB6Impg2nxSH0L6Oz3hlAO3P4lz4loLVrjM+Bdi3TC0LkTCZGsec9CUtccgl25DJz7AfVBLBwhOFAZE2QAAAM0AAABQSwECHgMKAAkAAAAtCGZdThQGRNkAAADNAAAACwAYAAAAAAAAAAAApIEAAAAAYXBpLWtleS50eHRVVAUAA+Ym7Wp1eAsAAQToAwAABOgDAABQSwUGAAAAAAEAAQBRAAAALgEAAAAA';
const bytes = value => new Uint8Array(Buffer.from(value,'base64'));
function pythonZip({name='api-key.txt',content=KEY,extraEntry=false,compression=8,comment='portable backup'} = {}) {
  const result = spawnSync('python3',['-c',[
    'import io,json,sys,zipfile',
    'p=json.loads(sys.stdin.read()); b=io.BytesIO()',
    'with zipfile.ZipFile(b,"w",compression=p["compression"]) as z:',
    ' z.writestr(p["name"],p["content"])',
    ' if p["extraEntry"]: z.writestr("other.txt","other")',
    ' z.comment=p["comment"].encode()',
    'sys.stdout.buffer.write(b.getvalue())'
  ].join('\n')],{input:JSON.stringify({name,content,extraEntry,compression,comment}),timeout:5000});
  assert.equal(result.status,0,result.stderr.toString()); return new Uint8Array(result.stdout);
}
test('key files accept UTF-8 BOM and surrounding whitespace without guessing JSON or Bearer prefixes', () => {
  for (const text of [KEY,'\ufeff'+KEY+'\r\n',' \n'+KEY+'\n ']) assert.equal(Zip.keyFile(new TextEncoder().encode(text)),KEY);
  for (const text of ['Bearer '+KEY,JSON.stringify({api_key:KEY}),KEY+'\nsecond_key_value','short','a'.repeat(513)]) {
    assert.throws(() => Zip.keyFile(new TextEncoder().encode(text)),/only the API key/);
  }
  assert.throws(() => Zip.keyFile(new Uint8Array([255,...new TextEncoder().encode(KEY)])),/only the API key/);
});
test('existing recovery export and independently encrypted stored and deflated ZIPs import', async () => {
  assert.equal(await Zip.importArchive(Zip.pack(KEY,webcrypto)),KEY);
  assert.equal(await Zip.importArchive(bytes(STORED)),KEY);
  await assert.rejects(Zip.importArchive(bytes(DEFLATED)),e => e.constructor.name==='ZipPasswordError');
  assert.equal(await Zip.importArchive(bytes(DEFLATED),'different password'),KEY);
  const check = spawnSync('python3',['-c','import io,sys,zipfile;sys.stdout.buffer.write(zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).read("api-key.txt",pwd=b"different password"))'],{input:Buffer.from(bytes(DEFLATED)),timeout:5000});
  assert.equal(check.status,0,check.stderr.toString()); assert.equal(check.stdout.toString(),KEY+'\r\n');
});
test('unencrypted ordinary stored/deflated ZIPs and archive comments import', async () => {
  for (const compression of [0,8]) assert.equal(await Zip.importArchive(pythonZip({compression})),KEY);
});
test('invalid key contents, multiple entries, paths, ZIP64-sized entries and unsupported methods never yield keys', async () => {
  for (const options of [{name:'../api-key.txt'},{extraEntry:true},{content:'short'},{content:'a'.repeat(1025)},{compression:12}]) {
    await assert.rejects(Zip.importArchive(pythonZip(options)));
  }
  const zip = pythonZip(), view = new DataView(zip.buffer), c = view.getUint32(zip.length-22-'portable backup'.length+16,true);
  view.setUint32(c+24,0xffffffff,true);
  await assert.rejects(Zip.importArchive(zip),/valid recovery ZIP/);
});
test('CRC failure, inconsistent sizes and truncation are rejected without leaking file contents', async () => {
  for (const offset of [0,6,8,14,18,22,30]) {
    const zip = pythonZip({compression:0}); zip[offset] ^= 255;
    await assert.rejects(Zip.importArchive(zip),e => !e.message.includes(KEY));
  }
  const zip = bytes(DEFLATED);
  for (let length=0;length<zip.length;length++) await assert.rejects(Zip.importArchive(zip.subarray(0,length)));
});
test('inflated bytes are bounded even when a malicious entry lies about its size', async () => {
  const zip = pythonZip({content:'x'.repeat(1000000)}), view = new DataView(zip.buffer);
  const e = zip.length-22-'portable backup'.length, c = view.getUint32(e+16,true);
  view.setUint32(22,32,true); view.setUint32(c+24,32,true);
  await assert.rejects(Zip.importArchive(zip),/valid recovery ZIP/);
});
test('unsupported browser decompression fails with a usable extracted-file fallback', async () => {
  const without = {TextEncoder,TextDecoder,Uint8Array};
  vm.runInNewContext(core+'\nthis.Zip = CredentialZip;',without);
  await assert.rejects(without.Zip.importArchive(bytes(DEFLATED)),/Extract api-key.txt/);
});
