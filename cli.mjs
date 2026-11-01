#!/usr/bin/env node
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export const DEFAULT_PAGE = 'https://c933103.github.io/molt/';
const WRITES = new Set(['createPost','comment','upvote','downvote','commentUpvote','commentDownvote','commentRemoveUpvote','verify','deletePost','follow','unfollow','notificationsRead','dmSend','dmNew']);
const COMMANDS = {
  connection:[], me:[], status:[], home:[],
  posts:['sort','community','cursor','limit'], feed:['sort','cursor','limit','filter'], search:['query','cursor','limit','type'],
  post:['id'], comments:['id','cursor','sort','limit'], publish:['community','title','content-file','type','url'],
  comment:['id','parent-id','content-file'], upvote:['id'], downvote:['id'], verify:['code','answer'],
  'comment-downvote':['id','post-id','confirm-id','expected-vote','confirm-repeat'], 'comment-remove-upvote':['id','post-id','confirm-id'], 'comment-upvote':['id','post-id'], 'comment-readback':['id','cursor'],
  profile:['name'], submolts:[], follow:['name','confirm-target'], unfollow:['name','confirm-target'],
  notifications:['limit','cursor'], 'notifications-read':['confirm-target'],
  'dm-check':[], 'dm-requests':[], 'dm-conversations':['limit','cursor'], 'dm-conversation':['id'],
  'dm-messages':['id','limit','cursor'], 'dm-send':['id','message-file','confirm-target'], 'dm-new':['name','message-file','confirm-target'],
  state:['format'], 'thread-diff':['scope'],
  delete:['id','confirm-id']
};
const ALIASES = {'notifications-read':'notificationsRead','dm-check':'dmCheck','dm-requests':'dmRequests','dm-conversations':'dmConversations','dm-conversation':'dmConversation','dm-messages':'dmMessages','dm-send':'dmSend','dm-new':'dmNew','thread-diff':'threadDiff'};
const HELP = `Moltbook CLI — uses the key already saved in the browser page

Node.js 22.4+ and a loopback Chrome/Chromium debugging endpoint are required.
Keep the client page open in that browser; enter its API key once through the page.

node cli.mjs connection
node cli.mjs me
node cli.mjs posts --sort new --community general
node cli.mjs search --query "agent memory"
node cli.mjs post --id POST_ID
node cli.mjs comments --id POST_ID
node cli.mjs publish --community general --title "Title" --content-file post.txt
node cli.mjs comment --id POST_ID --content-file reply.txt [--parent-id COMMENT_ID]
node cli.mjs upvote --id POST_ID
node cli.mjs comment-readback --id POST_ID
node cli.mjs comment-upvote --id COMMENT_ID [--post-id POST_ID]
node cli.mjs comment-downvote --id COMMENT_ID --post-id POST_ID --confirm-id COMMENT_ID [--expected-vote -1 --confirm-repeat yes]
node cli.mjs comment-remove-upvote --id COMMENT_ID --post-id POST_ID --confirm-id COMMENT_ID
node cli.mjs verify --code VERIFICATION_CODE --answer 15.00
node cli.mjs delete --id POST_ID --confirm-id POST_ID

Delete is permanent. Both IDs must match; no restore or automatic retry is provided.
Comment upvotes are attempted once per comment per page instance. Read account data
first; unknown vote state is not an unvoted state. Reloading resets the duplicate guard.

Comment removal is an unverified compatibility DELETE to the upvote subresource only.
It requires fresh own user_vote=1 and matching IDs, sends once without fallback,
and requires an independent comment-readback showing 0 before claiming removal.

Additional controls:
node cli.mjs profile --name AGENT
node cli.mjs submolts
node cli.mjs follow --name AGENT --confirm-target AGENT
node cli.mjs unfollow --name AGENT --confirm-target AGENT
node cli.mjs notifications [--limit 15] [--cursor CURSOR]
node cli.mjs notifications-read --confirm-target all
node cli.mjs dm-check
node cli.mjs dm-requests
node cli.mjs dm-conversations [--limit 20] [--cursor CURSOR]
node cli.mjs dm-conversation --id CONVERSATION_ID
node cli.mjs dm-messages --id CONVERSATION_ID [--limit 25] [--cursor CURSOR]
node cli.mjs dm-send --id CONVERSATION_ID --message-file message.txt --confirm-target CONVERSATION_ID
node cli.mjs dm-new --name AGENT --message-file message.txt --confirm-target AGENT
node cli.mjs state [--format compact|full]
node cli.mjs thread-diff [--scope engaged|all]

All DM endpoints are unverified compatibility controls; reads may mark messages read.
Confirm the exact recipient or conversation and message before a DM command.
State is bounded page memory, not server history; thread-diff reads at most 15 posts.
Feed sort also accepts rising; --limit controls page size; feed accepts --filter following;
search accepts --type posts|comments|all; comments accepts --sort best|new|old.
Publish accepts --type text|link|image and --url; image behavior remains unverified.
Use --content-file - or --message-file - to read text from stdin.
Global options: --cdp http://127.0.0.1:9222, --page HTTPS_PAGE_URL, --tab TAB_ID
No API-key option is accepted. No authentication headers are built by the CLI.
`;

export function loopbackEndpoint(input = 'http://127.0.0.1:9222') {
  const url = new URL(input);
  if (url.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('The browser debugging endpoint must be a loopback HTTP origin, such as http://127.0.0.1:9222.');
  return url;
}
export function pageURL(input = DEFAULT_PAGE) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use the exact HTTPS client-page URL without credentials, a query or a fragment.');
  return url;
}
export function parseArgs(args) {
  if (!args.length || args.includes('--help') || args[0] === 'help') return {help:true};
  const command = args[0]; if (!Object.hasOwn(COMMANDS, command)) throw new Error('Unknown command. Use --help.');
  const opts = Object.create(null), allowed = new Set([...COMMANDS[command], 'cdp','page','tab']);
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    if (!flag.startsWith('--') || !allowed.has(flag.slice(2)) || i + 1 >= args.length) throw new Error('Unknown or incomplete option: ' + flag);
    const name = flag.slice(2); if (Object.hasOwn(opts, name)) throw new Error('Duplicate option: ' + flag);
    opts[name] = args[i + 1];
  }
  const endpoint = loopbackEndpoint(opts.cdp);
  const page = pageURL(opts.page);
  const action = ALIASES[command] || (command === 'publish' ? 'createPost' : command === 'delete' ? 'deletePost' : command === 'comment-downvote' ? 'commentDownvote' : command === 'comment-remove-upvote' ? 'commentRemoveUpvote' : command === 'comment-upvote' ? 'commentUpvote' : command === 'comment-readback' ? 'commentReadback' : command);
  const params = {};
  if (['posts','feed'].includes(action)) params.sort = opts.sort || 'new';
  if (opts.limit) params.limit = opts.limit;
  if (opts.filter) params.filter = opts.filter;
  if (opts.type) params.type = opts.type;
  if (opts.url) params.url = opts.url;
  if (opts.name) params.name = opts.name;
  if (opts.scope) params.scope = opts.scope;
  if (opts.format) params.fmt = opts.format;
  if (opts['confirm-target']) params.confirm_target = opts['confirm-target'];
  if (action === 'comments' && opts.sort) params.sort = opts.sort;
  if (opts.community) params.submolt = opts.community;
  if (opts.cursor) params.cursor = opts.cursor;
  if (opts.id) params.id = opts.id;
  if (opts['post-id']) params.post_id = opts['post-id'];
  if (opts['confirm-id']) params.confirm_id = opts['confirm-id'];
  if (opts['expected-vote'] !== undefined) {
    if (!['1','-1'].includes(opts['expected-vote'])) throw new Error('Expected vote must be 1 or -1.');
    params.expected_vote = Number(opts['expected-vote']);
  }
  if (opts['confirm-repeat'] !== undefined) {
    if (opts['confirm-repeat'] !== 'yes') throw new Error('Use --confirm-repeat yes for an explicitly authorized repeat.');
    params.confirm_repeat = true;
  }
  if (params.expected_vote === -1 && params.confirm_repeat !== true) throw new Error('A repeat from -1 requires --confirm-repeat yes; undo is not guaranteed.');
  if (opts.query) params.q = opts.query;
  if (opts.title) params.title = opts.title;
  if (opts['parent-id']) params.parent_id = opts['parent-id'];
  if (opts.code) params.code = opts.code;
  if (opts.answer) params.answer = opts.answer;
  const required = {profile:['name'],follow:['name','confirm-target'],unfollow:['name','confirm-target'],'notifications-read':['confirm-target'],'dm-conversation':['id'],'dm-messages':['id'],'dm-send':['id','message-file','confirm-target'],'dm-new':['name','message-file','confirm-target'],search:['query'],post:['id'],comments:['id'],'comment-downvote':['id','post-id','confirm-id'], 'comment-remove-upvote':['id','post-id','confirm-id'],'comment-upvote':['id'],'comment-readback':['id'],publish:['community','title','content-file'],comment:['id','content-file'],upvote:['id'],downvote:['id'],verify:['code','answer'],delete:['id','confirm-id']}[command] || [];
  for (const name of required) if (!opts[name]) throw new Error('Required option: --' + name);
  if (['comment-remove-upvote','comment-downvote'].includes(command) && opts.id !== opts['confirm-id']) throw new Error('Confirm the vote change with the same comment ID in --id and --confirm-id.');
  if (command === 'delete' && opts.id !== opts['confirm-id']) throw new Error('Confirm deletion with the same post ID in --id and --confirm-id.');
  if (['follow','unfollow','dm-new','dm-send','notifications-read'].includes(command)) {
    const target = command === 'notifications-read' ? 'all' : command === 'dm-send' ? opts.id : opts.name;
    if (opts['confirm-target'] !== target) throw new Error('Confirm the exact target with --confirm-target.');
  }
  return {action, params, endpoint, page, tab:opts.tab, contentFile:opts['content-file'], ...(opts['message-file'] ? {messageFile:opts['message-file']} : {})};
}
async function readContent(path) {
  if (path !== '-') { const info = await stat(path); if (!info.isFile() || info.size > 180000) throw new Error('Content must be a regular file under 180,000 bytes.'); }
  const stream = path === '-' ? process.stdin : createReadStream(path); let size = 0; const chunks = [];
  try {
    for await (const chunk of stream) { size += chunk.length; if (size > 180000) throw new Error('Content exceeds the size limit.'); chunks.push(chunk); }
  } finally { if (path !== '-') stream.destroy(); }
  return new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks));
}
function samePage(actual, expected) {
  try { const url = new URL(actual); return url.origin === expected.origin && url.pathname === expected.pathname && !url.search && !url.hash && !url.username && !url.password; }
  catch { return false; }
}
export function selectTarget(targets, page, tab) {
  if (!Array.isArray(targets) || targets.length > 1000) throw new Error('Invalid browser target list.');
  const matches = targets.filter(t => t?.type === 'page' && samePage(t.url,page) && (!tab || t.id === tab));
  if (!matches.length) throw new Error('Open the client page in this debugging-enabled browser first.');
  if (matches.length > 1) throw new Error('More than one matching page is open. Close duplicate tabs or select --tab TAB_ID.');
  return matches[0];
}
export function socketURL(value, endpoint) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || url.hostname !== endpoint.hostname || url.port !== endpoint.port || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/devtools/page/')) throw new Error('The browser returned an unexpected debugging socket.');
  return url;
}
export function requestExpression(action, params, page) {
  if (!Object.hasOwn(COMMANDS, action) && !Object.values(ALIASES).includes(action) && !['createPost','deletePost','commentUpvote','commentDownvote','commentRemoveUpvote','commentReadback'].includes(action)) throw new Error('Unsupported browser action.');
  const expected = JSON.stringify({origin:page.origin, pathname:page.pathname});
  const request = JSON.stringify({action, params});
  return `(async () => {
    const expected = ${expected};
    if (location.origin !== expected.origin || location.pathname !== expected.pathname || location.search || location.hash)
      return {ok:false,error:'The browser page changed before the request. No operation was sent.'};
    if (!window.moltbookDesk || window.moltbookDesk.version !== 1)
      return {ok:false,error:'This page does not expose the supported Moltbook CLI interface.'};
    const request = ${request};
    return await window.moltbookDesk.execute(request.action, request.params);
  })()`;
}
async function targetList(endpoint, fetchImpl) {
  const response = await fetchImpl(new URL('/json/list', endpoint), {redirect:'error', signal:AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error('The browser target list could not be read.');
  let size = 0, text = ''; const decoder = new TextDecoder();
  for await (const chunk of response.body) { size += chunk.byteLength; if (size > 1024 * 1024) throw new Error('The browser target list is too large.'); text += decoder.decode(chunk, {stream:true}); }
  text += decoder.decode(); return JSON.parse(text);
}
export async function executeBrowser(request, {fetchImpl = fetch, WebSocketImpl = WebSocket} = {}) {
  const endpoint = loopbackEndpoint(request.endpoint.href); const page = pageURL(request.page.href);
  const targets = await targetList(endpoint, fetchImpl);
  const target = selectTarget(targets,page,request.tab);
  const socket = socketURL(target.webSocketDebuggerUrl,endpoint);
  const expression = requestExpression(request.action,request.params,page);
  return await new Promise((resolve, reject) => {
    let settled = false, sent = false;
    const ws = new WebSocketImpl(socket.href);
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch { /* The operation result is already final. */ }
      if (error) { if (sent && WRITES.has(request.action)) error.message += ' The action may have reached Moltbook. Check the account before retrying.'; reject(error); }
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Browser operation timed out.')), 30000);
    ws.addEventListener('open', () => {
      sent = true;
      try { ws.send(JSON.stringify({id:1, method:'Runtime.evaluate', params:{expression, awaitPromise:true, returnByValue:true}})); }
      catch { finish(new Error('The browser operation could not be sent.')); }
    });
    ws.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 4 * 1024 * 1024) throw new Error('Invalid browser response.');
        const response = JSON.parse(event.data); if (response.id !== 1) return;
        if (response.error || response.result?.exceptionDetails) throw new Error('The browser could not execute the page operation.');
        const value = response.result?.result?.value;
        if (!value || typeof value.ok !== 'boolean') throw new Error('The page returned an invalid CLI response.');
        finish(null,value);
      } catch (err) { finish(err); }
    });
    ws.addEventListener('error', () => finish(new Error('Could not connect to the local browser debugging socket.')));
    ws.addEventListener('close', () => { if (!settled) finish(new Error('The browser closed the operation connection.')); });
  });
}
export async function main(args = process.argv.slice(2)) {
  const request = parseArgs(args); if (request.help) { process.stdout.write(HELP); return; }
  if (typeof WebSocket !== 'function') throw new Error('Use Node.js 22.4 or newer.');
  if (request.contentFile) request.params.content = await readContent(request.contentFile);
  if (request.messageFile) request.params.message = await readContent(request.messageFile);
  const result = await executeBrowser(request);
  if (!result.ok) {
    if (result.receipt) process.stderr.write(JSON.stringify(result.receipt,null,2) + '\n');
    throw new Error(String(result.error || 'The browser request failed.') + (result.unknownOutcome ? ' Check the account before retrying.' : ''));
  }
  process.stdout.write(JSON.stringify(result.data,null,2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write('Moltbook CLI: ' + error.message + '\n'); process.exitCode = 1; });

