// aitutor — Gemini 모델 목록 자동 갱신
// Copyright (c) 2026 서담 한민수 (Han Minsu), 동명대학교 · CC BY-NC-ND 4.0
//
// GitHub Actions(.github/workflows/update-models.yml)가 매주 실행합니다.
//  1) Gemini API의 모델 목록(models.list)에서 새 안정판 모델을 찾고
//  2) 구글의 '지원 중단 일정' 문서에서 종료일·대체 모델을 읽고
//  3) 후보 모델마다 아주 짧은 시험 호출을 해서 실제로 쓸 수 있는지 확인한 뒤
//  4) models.json을 고칩니다 (새 모델 추가, 종료·대체된 모델 삭제).
// 앱(index.html)은 열릴 때 models.json을 읽어 모델 선택 목록을 만듭니다.
//
// 규칙은 models.json의 "rules"에서 바꿀 수 있습니다.
//   families               목록에 둘 계열 (flash, flash-lite, pro)
//   perFamily              계열마다 최신 몇 개를 둘지
//   defaultFamily          기본 모델로 삼을 계열 (그 계열의 최신판)
//   dropDaysBeforeShutdown 종료일 며칠 전부터 목록에서 뺄지
//   pin                    규칙과 상관없이 늘 남겨 둘 모델 (종료되면 빠지고, 다시 쓸 수 있게 되면 돌아옴)
//   exclude                절대 넣지 않을 모델

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const DEPRECATIONS_URL = 'https://ai.google.dev/gemini-api/docs/deprecations?hl=en';
const KEEPALIVE_DAYS = 45;     // 바뀐 것이 없어도 이 기간마다 checked 날짜를 고쳐 커밋 (예약 실행이 멈추지 않게)

const DEFAULT_RULES = {
  families: ['flash', 'flash-lite'], perFamily: 2, defaultFamily: 'flash',
  dropDaysBeforeShutdown: 21, pin: [], exclude: [],
};

/* ── 모델 이름 풀이 ──
   안정판만: gemini-3.8-flash, gemini-3.5-flash-lite, gemini-2.5-pro
   (preview·exp·latest·날짜·tts·image·live 등 꼬리가 붙은 것은 제외) */
export function parseId(id) {
  const m = /^gemini-(\d+(?:\.\d+)?)-(flash-lite|flash|pro)$/.exec(id);
  if (!m) return null;
  return { id, ver: m[1], family: m[2] };
}
export function cmpVer(a, b) {           // 큰 판이 앞으로
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}
export function labelOf(id) {
  const p = parseId(id);
  if (!p) return id.replace(/^gemini-/, '');
  const fam = { flash: 'Flash', 'flash-lite': 'Flash Lite', pro: 'Pro' }[p.family];
  return `${p.ver} ${fam}`;
}

/* ── 지원 중단 일정 문서 읽기 ──
   표마다 머리줄에서 '종료일'·'대체 모델' 칸 위치를 찾고, 각 줄의 모델 이름을 모읍니다.
   문서 모양이 바뀌어 못 읽으면 빈 결과를 돌려주고, 그때는 시험 호출 결과만으로 판단합니다. */
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function strip(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();
}
export function parseDate(s) {
  let m = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(s);
  if (m) return new Date(Date.UTC(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]));
  m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return null;
}
const ID_RE = /\bgemini-[a-z0-9][a-z0-9.\-]*[a-z0-9]\b/gi;
export function parseDeprecations(html) {
  const out = new Map();
  for (const tbl of html.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const rows = tbl.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    let iShut = -1, iRep = -1;
    for (const row of rows) {
      const ths = row.match(/<th[\s\S]*?<\/th>/gi);
      if (ths) {
        const hs = ths.map(strip);
        iShut = hs.findIndex(h => /shut\s*down|discontinu|retire/i.test(h));
        iRep = hs.findIndex(h => /replace|migrat|recommend/i.test(h));
        continue;
      }
      const cells = (row.match(/<td[\s\S]*?<\/td>/gi) || []).map(strip);
      if (cells.length < 2) continue;
      const ids = cells[0].match(ID_RE);
      if (!ids) continue;
      let shutTxt = iShut >= 0 ? cells[iShut] || '' : '';
      if (iShut < 0) {                    // 머리줄을 못 찾으면: 날짜가 둘이면 뒤의 것이 종료일
        const ds = cells.slice(1).filter(c => parseDate(c));
        shutTxt = ds.length >= 2 ? ds[1] : '';
      }
      const repTxt = iRep >= 0 ? cells[iRep] || '' : cells[cells.length - 1];
      const rowTxt = cells.join(' ');
      const info = {
        shutdown: parseDate(shutTxt),
        replacement: [...new Set((repTxt.match(ID_RE) || []).map(s => s.toLowerCase()))],
        autoRouted: /automatic(ally)?\s+rout|routes?\s+(api\s+)?requests?\s+to/i.test(rowTxt),
      };
      for (const id of ids) {
        const k = id.toLowerCase();
        info.replacement = info.replacement.filter(r => r !== k);
        if (!out.has(k)) out.set(k, info);
      }
    }
  }
  return out;
}

/* ── API ── */
async function listModels(fetch, key) {
  const ids = [];
  let token = '';
  for (let guard = 0; guard < 20; guard++) {
    const r = await fetch(`${API}/models?pageSize=1000&key=${key}${token ? '&pageToken=' + token : ''}`);
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`모델 목록을 받지 못했습니다 (HTTP ${r.status}) ${t.slice(0, 200)}`);
    }
    const d = await r.json();
    for (const m of d.models || []) {
      if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
      ids.push(String(m.name || '').replace(/^models\//, ''));
    }
    if (!d.nextPageToken) break;
    token = encodeURIComponent(d.nextPageToken);
  }
  return ids;
}
// 시험 호출: ok(쓸 수 있음) / gone(종료·없음) / denied(이 키로 못 씀·유료 전용) / unknown(일시 오류)
async function probe(fetch, key, id) {
  try {
    const r = await fetch(`${API}/models/${id}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }], generationConfig: { maxOutputTokens: 16 } }),
    });
    if (r.ok) {
      // 응답의 modelVersion: 옛 이름으로 불러도 새 모델이 답하면(자동 전달) 그 이름이 옴
      const d = await r.json().catch(() => ({}));
      const m = /^gemini-(\d+(?:\.\d+)?)-(flash-lite|flash|pro)/.exec(String(d.modelVersion || ''));
      const served = m ? `gemini-${m[1]}-${m[2]}` : '';
      return { state: 'ok', routedTo: served && served !== id ? served : '' };
    }
    const t = await r.text().catch(() => '');
    let msg = t; try { msg = JSON.parse(t).error.message || t; } catch (_) {}
    msg = String(msg).slice(0, 160);
    if (r.status === 404 || /no longer available|not found|deprecated|retired|shut ?down/i.test(msg)) return { state: 'gone', msg };
    if (r.status === 403 || r.status === 401 || (r.status === 400 && /billing|not available|free tier|permission/i.test(msg))) return { state: 'denied', msg };
    if (r.status === 429 && /limit: 0\b|free_tier.*limit.*\b0\b/i.test(msg)) return { state: 'denied', msg };   // 무료 할당량 0 = 유료 전용
    return { state: 'unknown', msg: `HTTP ${r.status} ${msg}` };
  } catch (e) {
    return { state: 'unknown', msg: String(e.message || e) };
  }
}

/* ── 고르기 ── */
export function choose({ cfg, listed, dep, probes, now }) {
  const rules = { ...DEFAULT_RULES, ...(cfg.rules || {}) };
  const day = 86400000;
  const cur = new Set((cfg.models || []).map(m => m.id));
  const notes = [];
  const why = new Map();      // 뺀 이유

  const usable = id => {
    if (rules.exclude.includes(id)) { why.set(id, '제외 목록(exclude)'); return false; }
    const d = dep.get(id);
    if (d && d.shutdown && d.shutdown.getTime() - now.getTime() <= rules.dropDaysBeforeShutdown * day) {
      why.set(id, `종료 예정 ${d.shutdown.toISOString().slice(0, 10)}`); return false;
    }
    const pr = probes.get(id);
    if (pr && pr.state === 'gone') { why.set(id, `종료됨 (${pr.msg})`); return false; }
    // pin 모델: 종료일이 다가오거나 '더 이상 쓸 수 없음'이 올 때만 뺌.
    // (2.5 계열처럼 '써 온 사용자만' 쓸 수 있는 모델은 키에 따라 거절될 수 있으므로 그 밖의 오류로는 빼지 않음)
    if (rules.pin.includes(id)) return true;
    if (pr && pr.state === 'denied') { why.set(id, `이 키로 쓸 수 없음 (${pr.msg})`); return false; }
    // 시험 호출이 일시 오류면: 이미 목록에 있던 것만 남기고, 새 모델은 다음 실행 때 다시 봄
    if (!pr || pr.state === 'unknown') { if (!cur.has(id)) { why.set(id, `확인 실패 (${pr ? pr.msg : '호출 안 함'})`); return false; } }
    if (!listed.has(id) && !(pr && pr.state === 'ok')) { why.set(id, 'API 목록에 없음'); return false; }
    return true;
  };

  const pool = [...new Set([...listed, ...cur, ...rules.pin])].map(parseId).filter(Boolean)
    .filter(p => rules.families.includes(p.family) || rules.pin.includes(p.id) || cur.has(p.id))
    .filter(p => usable(p.id));
  const ok = new Set(pool.map(p => p.id));
  // 앞으로만: 지금 목록에 있는 같은 계열의 가장 옛 판보다 더 옛 모델은 새로 넣지 않음
  // (예: 3.1 Flash Lite가 종료돼 빠질 때 2.5 Flash Lite가 다시 들어오는 일 막기)
  const floor = {};
  for (const id of cur) { const p = parseId(id); if (p && (!floor[p.family] || cmpVer(p.ver, floor[p.family]) > 0)) floor[p.family] = p.ver; }
  for (const p of pool) {
    if (!cur.has(p.id) && !rules.pin.includes(p.id) && floor[p.family] && cmpVer(p.ver, floor[p.family]) > 0) {
      ok.delete(p.id); why.set(p.id, `지금 목록보다 옛 판`);
    }
  }

  // 옛 이름이 새 모델로 자동 전달되는 경우(예: 3.5 Flash → 3.6 Flash)는 같은 모델이 둘이 되므로 뺌.
  // 판단: 시험 호출에 다른 모델이 답했거나, 지원 중단 문서에 '자동 전달'이라고 적혀 있을 때.
  // (종료일만 잡힌 모델은 종료일 가까이 될 때까지 남겨 둠)
  for (const p of [...pool]) {
    if (rules.pin.includes(p.id)) continue;
    const pr = probes.get(p.id), d = dep.get(p.id);
    const to = (pr && pr.routedTo) || (d && d.autoRouted && d.replacement[0]) || '';
    if (to) { ok.delete(p.id); why.set(p.id, `${to}(으)로 자동 전달되는 옛 이름`); }
  }

  const picked = [];
  for (const fam of rules.families) {
    const fs = pool.filter(p => p.family === fam && ok.has(p.id)).sort((a, b) => cmpVer(a.ver, b.ver));
    fs.slice(0, rules.perFamily).forEach(p => picked.push(p.id));
    fs.slice(rules.perFamily).forEach(p => why.set(p.id, `더 새 ${labelOf(p.id).replace(/^[\d.]+ /, '')} 모델이 ${rules.perFamily}개 있음`));
  }
  for (const id of rules.pin) if (ok.has(id) && !picked.includes(id)) picked.push(id);

  const models = picked.map(id => {
    const m = { id, label: labelOf(id) };
    const d = dep.get(id);
    if (d && d.shutdown) m.shutdown = d.shutdown.toISOString().slice(0, 10);
    return m;
  });
  const famFirst = models.find(m => parseId(m.id)?.family === rules.defaultFamily);
  const def = famFirst ? famFirst.id : (models[0] && models[0].id);

  const added = picked.filter(id => !cur.has(id));
  const removed = [...cur].filter(id => !picked.includes(id));
  for (const id of added) notes.push(`+ ${id} 추가`);
  for (const id of removed) notes.push(`- ${id} 삭제: ${why.get(id) || '규칙에 맞지 않음'}`);
  if (def !== cfg.default) notes.push(`기본 모델: ${cfg.default || '(없음)'} → ${def}`);
  return { models, default: def, notes, why };
}

/* ── 실행 ── */
export async function run({ fetch, key, cfgText, now = new Date(), log = console.log }) {
  const cfg = JSON.parse(cfgText);
  if (!key) throw new Error('GEMINI_API_KEY 비밀값이 없습니다. 저장소 Settings → Secrets and variables → Actions 에 넣어 주세요.');

  const listedArr = await listModels(fetch, key);
  const listed = new Set(listedArr.filter(id => parseId(id)));
  log(`API 목록: 안정판 후보 ${listed.size}개 — ${[...listed].join(', ')}`);

  let dep = new Map();
  try {
    const r = await fetch(DEPRECATIONS_URL, { headers: { 'Accept-Language': 'en' } });
    if (r.ok) dep = parseDeprecations(await r.text());
    log(`지원 중단 문서: 모델 ${dep.size}개 읽음`);
  } catch (e) { log(`지원 중단 문서를 읽지 못했습니다 (${e.message}) — 시험 호출 결과만으로 판단합니다`); }

  const rules = { ...DEFAULT_RULES, ...(cfg.rules || {}) };
  const toProbe = [...new Set([...(cfg.models || []).map(m => m.id), ...rules.pin,
    ...[...listed].filter(id => rules.families.includes(parseId(id).family))])];
  const probes = new Map();
  for (const id of toProbe) {
    const pr = await probe(fetch, key, id);
    probes.set(id, pr);
    log(`  시험 ${id}: ${pr.state}${pr.msg ? ' — ' + pr.msg : ''}`);
  }
  if (toProbe.length && [...probes.values()].every(p => p.state !== 'ok')) {
    throw new Error('모든 모델 시험 호출이 실패했습니다. API 키가 잘못됐거나 할당량을 넘었을 수 있습니다. models.json은 그대로 둡니다.');
  }

  const res = choose({ cfg, listed, dep, probes, now });
  if (res.models.length < 2) {
    throw new Error(`쓸 수 있는 모델이 ${res.models.length}개뿐이라 바꾸지 않습니다. 기록: ${res.notes.join(' / ')}`);
  }

  const today = now.toISOString().slice(0, 10);
  const same = JSON.stringify(res.models) === JSON.stringify(cfg.models) && res.default === cfg.default;
  const stale = !cfg.checked || (now - new Date(cfg.checked + 'T00:00:00Z')) / 86400000 >= KEEPALIVE_DAYS;
  if (same && !stale) return { changed: false, notes: [], cfg };

  const next = { checked: today, default: res.default, models: res.models, rules: cfg.rules || DEFAULT_RULES };
  return { changed: true, contentChanged: !same, notes: same ? ['변경 없음 (확인 날짜만 갱신)'] : res.notes, text: JSON.stringify(next, null, 2) + '\n', cfg: next };
}

// 직접 실행할 때 (GitHub Actions)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] || 'models.json';
  const out = process.env.GITHUB_OUTPUT, sum = process.env.GITHUB_STEP_SUMMARY;
  try {
    const res = await run({ fetch: globalThis.fetch, key: process.env.GEMINI_API_KEY, cfgText: await readFile(file, 'utf8') });
    if (res.changed) await writeFile(file, res.text);
    const title = !res.changed ? '변경 없음' : res.contentChanged ? '모델 목록 갱신' : '확인 날짜 갱신';
    console.log(`\n${title}\n${res.notes.join('\n')}`);
    if (out) await appendFile(out, `changed=${res.changed}\ntitle=${title}\n`);
    if (sum) await appendFile(sum, `### Gemini 모델 점검 — ${title}\n\n${res.notes.map(n => `- ${n}`).join('\n') || '- 바뀐 것 없음'}\n\n현재 목록: ${res.cfg.models.map(m => '`' + m.id + '`' + (m.id === res.cfg.default ? ' (기본)' : '')).join(', ')}\n`);
    if (res.changed) await writeFile('.models-commit-msg', `모델 목록 자동 갱신: ${title}\n\n${res.notes.join('\n')}\n`);
  } catch (e) {
    console.error('오류: ' + e.message);
    if (sum) await appendFile(sum, `### Gemini 모델 점검 실패\n\n${e.message}\n`);
    process.exit(1);
  }
}
