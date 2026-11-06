// Netlify Function — READ-ONLY Monday.com proxy for the Payroll / EHT / WCB dashboard and the
// WinTeams -> NetSuite JE Converter (each site carries its own identical copy).
//
// A trimmed copy of the converter's netlify/functions/monday.mjs. Differences:
//
//   1. READ ONLY. The payroll dashboard never writes master data, so this copy has
//      no updateItem / createItem / createItems. Nobody who reaches this site can
//      change a Monday board through it.
//
//   2. TWO BOARDS. Only 'accounts' (Chart of Accounts) and 'jobs'. The client asks
//      by logical name; the numeric id comes from an env var, so the token can't be
//      pointed at any other board in the account.
//
//   3. ONE PAGE PER CALL. The Jobs board took ~19 s to read in one call from the
//      converter site. A Netlify function is normally stopped at 10 s, so here the
//      DASHBOARD walks the pages: each call returns at most 500 items plus a cursor,
//      and the dashboard calls again with that cursor until it comes back empty.
//      Only the columns the dashboard reads are fetched, which keeps each page small.
//
//   4. SAME-ORIGIN ONLY. No Access-Control-Allow-Origin header: the dashboard is
//      served from this same site, behind the site password, so nothing else needs
//      to call this function from a browser.
//
// Deployed at: /.netlify/functions/monday
// .mjs, not .js — the file uses `export const handler` (see the converter's notes).
//
// Required env vars on Netlify (Site configuration -> Environment variables):
//   MONDAY_TOKEN            — personal API token (treat like a password)
//   MONDAY_BOARD_ACCOUNTS   — 18428027547
//   MONDAY_BOARD_JOBS       — 18428027137
//
// Requests (POST application/json):
//   { action:'health' }                                   — no token needed
//   { action:'getPage', board:'accounts' }                — first page + columns
//   { action:'getPage', board:'jobs', cursor:'...' }      — next page
// Response: { board:{id,name,columns}, items:[{id,name,column_values:[{id,text}]}], cursor }
// Errors:   { error:'human message', details? } with HTTP 4xx/5xx.

const MONDAY_API = 'https://api.monday.com/v2';
const API_VERSION = '2024-10';
const PAGE = 500;

const BOARD_ENV = {
  accounts: 'MONDAY_BOARD_ACCOUNTS',
  jobs:     'MONDAY_BOARD_JOBS',
};

// The column titles the dashboard reads. Anything else on the board is not fetched.
const WANT = {
  accounts: ['Account Name', 'NS Internal ID', 'WT GL Number', 'Type', 'Status'],
  jobs:     ['WT Job Number', 'Customer Code', 'Job Name', 'NS Internal ID', 'Subsidiary',
             'Shared Job Number', 'Status'],
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

async function gql(token, query, variables) {
  const res = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { 'Authorization': token, 'Content-Type': 'application/json', 'API-Version': API_VERSION },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return { ok: false, error: `Monday returned non-JSON (status ${res.status})`, raw: text.slice(0, 500) }; }
  if (!res.ok) return { ok: false, error: `Monday HTTP ${res.status}`, details: parsed };
  if (parsed.errors) return { ok: false, error: 'Monday GraphQL error', details: parsed.errors };
  return { ok: true, data: parsed.data };
}

async function getPage(token, boardName, boardId, cursor) {
  // Column ids are looked up by TITLE on every call rather than hard-coded:
  // Monday gives a recreated column a new id.
  const meta = await gql(token,
    `query ($b: [ID!]) { boards(ids: $b) { id name columns { id title type } } }`,
    { b: [String(boardId)] });
  if (!meta.ok) return meta;
  const board = meta.data && meta.data.boards && meta.data.boards[0];
  if (!board) return { ok: false, error: `Board ${boardId} not found, or the token has no access to it` };
  const want = new Set(WANT[boardName]);
  const columns = board.columns.filter(c => want.has((c.title || '').trim()));
  const ids = columns.map(c => c.id);

  let page;
  if (!cursor) {
    const r = await gql(token,
      `query ($b: [ID!], $ids: [String!]) { boards(ids: $b) { items_page(limit: ${PAGE}) {
         cursor items { id name column_values(ids: $ids) { id text } } } } }`,
      { b: [String(boardId)], ids });
    if (!r.ok) return r;
    page = r.data.boards[0].items_page;
  } else {
    const r = await gql(token,
      `query ($c: String!, $ids: [String!]) { next_items_page(limit: ${PAGE}, cursor: $c) {
         cursor items { id name column_values(ids: $ids) { id text } } } }`,
      { c: String(cursor), ids });
    if (!r.ok) return r;
    page = r.data.next_items_page;
  }
  return { ok: true, data: {
    board: { id: board.id, name: board.name, columns },
    items: (page && page.items) || [],
    cursor: (page && page.cursor) || null,
  } };
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: `Method ${event.httpMethod} not allowed` });
  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Body is not valid JSON' }); }

  const action = payload.action || 'getPage';
  if (action === 'health') {
    const configured = {};
    Object.entries(BOARD_ENV).forEach(([n, k]) => { configured[n] = !!process.env[k]; });
    return json(200, { ok: true, readOnly: true, tokenSet: !!process.env.MONDAY_TOKEN, boardsConfigured: configured });
  }
  if (action !== 'getPage') return json(400, { error: `This copy is read-only. Unknown action: ${action}` });

  const name = payload.board;
  const key = BOARD_ENV[name];
  if (!key) return json(400, { error: `Unknown board '${name}'. Expected one of: ${Object.keys(BOARD_ENV).join(', ')}` });
  const boardId = process.env[key];
  if (!boardId) return json(500, { error: `${key} env var not set on Netlify` });
  const token = process.env.MONDAY_TOKEN;
  if (!token) return json(500, { error: 'MONDAY_TOKEN env var not set on Netlify' });

  try {
    const r = await getPage(token, name, boardId, payload.cursor);
    if (!r.ok) return json(502, r);
    return json(200, r.data);
  } catch (e) {
    return json(500, { error: 'Function crashed', message: String((e && e.message) || e) });
  }
};
