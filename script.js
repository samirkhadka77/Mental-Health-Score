/* MindScope – frontend for the FastAPI Student Mental Health Prediction API */
'use strict';

/* ---------- Configuration ---------- */

const API_BASE = 'http://127.0.0.1:2200';
const PREDICT_URL = `${API_BASE}/predict`;
const SCORE_MAX = 10;               // scale used by the gauge only; the displayed number is the raw API value
const HISTORY_KEY = 'mindscope.history.v1';
const HISTORY_LIMIT = 50;
const REQUEST_TIMEOUT_MS = 20000;

/* Dropdown options – values match the Literal[...] types in the backend exactly */
const OPTIONS = {
  gender: ['Male', 'Female', 'Other'],
  country: ['India', 'USA', 'UK', 'Canada', 'Australia', 'Germany', 'France', 'Mexico', 'Turkey', 'Other'],
  academic_level: ['High School', 'Undergraduate', 'Graduate', 'Other'],
  most_used_platform: ['Facebook', 'Instagram', 'TikTok', 'YouTube', 'Snapchat', 'Twitter', 'LinkedIn', 'WhatsApp',
    'WeChat', 'LINE', 'KakaoTalk', 'VKontakte'],
  purpose_of_use: ['Networking', 'Education', 'Entertainment', 'News'],
  stress_level: ['Low', 'Medium', 'High', 'Very High']
};

/* Field definitions: json key, label, type and validation limits (mirrors the Pydantic model) */
const FIELDS = [
  { key: 'age', label: 'Age', type: 'int', min: 10, max: 100 },
  { key: 'gender', label: 'Gender', type: 'select' },
  { key: 'country', label: 'Country', type: 'select' },
  { key: 'academic_level', label: 'Academic level', type: 'select' },
  { key: 'most_used_platform', label: 'Most used platform', type: 'select' },
  { key: 'purpose_of_use', label: 'Purpose of use', type: 'select' },
  { key: 'avg_daily_usage_hours', label: 'Average daily usage', type: 'float', min: 0, max: 24, unit: 'h' },
  { key: 'daily_unlocks', label: 'Daily unlocks', type: 'int', min: 0 },
  { key: 'study_hours', label: 'Study hours', type: 'float', min: 0, max: 24, unit: 'h' },
  { key: 'physical_activity_hours', label: 'Physical activity', type: 'float', min: 0, max: 24, unit: 'h' },
  { key: 'sleep_hours_per_night', label: 'Sleep per night', type: 'float', min: 0, max: 24, unit: 'h' },
  { key: 'stress_level', label: 'Stress level', type: 'select' }
];

/* Score interpretation (assumes 0–10, higher = better mental health) */
const BANDS = [
  { min: 8, label: 'Strong wellbeing', text: 'The model predicts a high mental health score for this student profile.' },
  { min: 6, label: 'Moderate wellbeing', text: 'The model predicts a middle-range score. Habits like sleep and activity may be worth watching.' },
  { min: 4, label: 'Below average', text: 'The model predicts a lower score. Reducing screen time and protecting sleep are common areas to review.' },
  { min: -Infinity, label: 'Low wellbeing', text: 'The model predicts a low score. Consider speaking with a counsellor or health professional.' }
];

/* ---------- Helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const form = $('#assessForm');
const fmt = n => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const bandFor = s => BANDS.find(b => s >= b.min);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

let currentResult = null;

/* ---------- History (localStorage) ---------- */
function loadHistory() {
  try {
    const data = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT))); }
  catch { toast('Could not save history: browser storage is unavailable.'); }
}

/* ---------- Navigation ---------- */
const VIEWS = ['dashboard', 'assess', 'results', 'history', 'about'];
function showView(name) {
  if (!VIEWS.includes(name)) name = 'dashboard';
  VIEWS.forEach(v => { $(`#view-${v}`).hidden = v !== name; });
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name && a.closest('.nav')));
  $('#mainNav').classList.remove('open');
  $('#menuBtn').setAttribute('aria-expanded', 'false');
  if (name === 'dashboard') renderDashboard();
  if (name === 'history') renderHistory();
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
$('#menuBtn').addEventListener('click', e => {
  const open = $('#mainNav').classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', String(open));
});

/* ---------- API status ---------- */
async function checkApi() {
  const el = $('#apiStatus'), label = $('span', el);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${API_BASE}/`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error();
    el.className = 'api-status ok'; label.textContent = 'API online';
  } catch {
    el.className = 'api-status down'; label.textContent = 'API offline';
  }
}

/* ---------- Form setup ---------- */
function populateSelects() {
  $$('select[data-options]').forEach(sel => {
    const opts = OPTIONS[sel.dataset.options];
    sel.innerHTML = '<option value="" disabled selected>Select…</option>' +
      opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  });
}

function validateField(def, showErrors = true) {
  const input = form.elements[def.key];
  const wrap = input.closest('.field');
  const raw = input.value.trim();
  let msg = '';
  if (raw === '') {
    msg = def.type === 'select' ? 'Please choose an option.' : 'This field is required.';
  } else if (def.type !== 'select') {
    const n = Number(raw);
    if (!Number.isFinite(n)) msg = 'Enter a valid number.';
    else if (def.type === 'int' && !Number.isInteger(n)) msg = 'Enter a whole number.';
    else if (def.min !== undefined && n < def.min) msg = `Must be at least ${def.min}.`;
    else if (def.max !== undefined && n > def.max) msg = `Must be at most ${def.max}.`;
  } else if (!OPTIONS[def.key].includes(raw)) {
    msg = 'Choose one of the listed options.';
  }
  if (showErrors) {
    wrap.classList.toggle('invalid', !!msg);
    wrap.classList.toggle('valid', !msg);
    $('.err', wrap).textContent = msg;
  }
  return msg;
}

function updateProgress() {
  const done = FIELDS.filter(f => form.elements[f.key].value.trim() !== '').length;
  $('#progressBar').style.width = `${(done / FIELDS.length) * 100}%`;
  $('#progressLabel').textContent = `${done} of ${FIELDS.length} fields completed`;
  const sum = ['avg_daily_usage_hours', 'study_hours', 'sleep_hours_per_night', 'physical_activity_hours']
    .reduce((t, k) => t + (Number(form.elements[k].value) || 0), 0);
  const w = $('#hoursWarning');
  w.hidden = sum <= 24;
  if (sum > 24) w.textContent = `Usage, study, sleep and activity add up to ${fmt(sum)} hours, which is more than a day. Overlap is possible, so you can still submit.`;
}

function buildPayload() {
  const payload = {};
  FIELDS.forEach(f => {
    const v = form.elements[f.key].value.trim();
    payload[f.key] = f.type === 'select' ? v : (f.type === 'int' ? parseInt(v, 10) : parseFloat(v));
  });
  return payload;
}

function showFormAlert(title, items = []) {
  const a = $('#formAlert');
  a.innerHTML = `${esc(title)}${items.length ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}`;
  a.hidden = false;
  a.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
const clearFormAlert = () => { $('#formAlert').hidden = true; };

function setLoading(on) {
  const btn = $('#submitBtn');
  btn.classList.toggle('loading', on);
  btn.disabled = on;
  $('.label', btn).textContent = on ? 'Analysing…' : 'Predict mental health score';
  $('#resetBtn').disabled = on;
}

function resetForm() {
  form.reset();
  $$('.field', form).forEach(f => { f.classList.remove('invalid', 'valid'); $('.err', f).textContent = ''; });
  clearFormAlert();
  updateProgress();
}

/* ---------- Submit ---------- */
form.addEventListener('submit', async e => {
  e.preventDefault();
  clearFormAlert();
  const errors = FIELDS.map(f => ({ f, m: validateField(f) })).filter(x => x.m);
  if (errors.length) {
    form.elements[errors[0].f.key].focus();
    showFormAlert('Please fix the highlighted fields.', errors.map(x => `${x.f.label}: ${x.m}`));
    return;
  }

  const payload = buildPayload();
  setLoading(true);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(PREDICT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });

    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error body */ }

    if (!res.ok) { handleApiError(res.status, body); return; }

    const score = body && body.prediction_mental_health_score;
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      showFormAlert('The API replied, but the response did not contain a valid prediction_mental_health_score.');
      return;
    }

    const record = { id: Date.now(), createdAt: new Date().toISOString(), score, inputs: payload };
    const list = loadHistory();
    list.unshift(record);
    saveHistory(list);
    updateHistoryCount();
    showResult(record);
    location.hash = 'results';
  } catch (err) {
    if (err.name === 'AbortError') {
      showFormAlert(`The request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds. Check that the API is running and try again.`);
    } else {
      showFormAlert(`Could not reach the API at ${API_BASE}.`, [
        'Make sure the FastAPI server is running (uvicorn main:app --reload).',
        'Check the address and port in API_BASE at the top of script.js.'
      ]);
    }
    checkApi();
  } finally {
    clearTimeout(timer);
    setLoading(false);
  }
});

function handleApiError(status, body) {
  if (status === 422 && body && Array.isArray(body.detail)) {
    const lines = [];
    body.detail.forEach(d => {
      const key = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : '';
      const def = FIELDS.find(f => f.key === key);
      if (def) {
        const wrap = form.elements[key].closest('.field');
        wrap.classList.add('invalid'); wrap.classList.remove('valid');
        $('.err', wrap).textContent = d.msg;
        lines.push(`${def.label}: ${d.msg}`);
      } else {
        lines.push(d.msg || 'Invalid value.');
      }
    });
    showFormAlert('The API rejected some values.', lines);
    return;
  }
  if (status >= 500) {
    const detail = body && typeof body.detail === 'string' ? body.detail : '';
    showFormAlert(`The server hit an internal error (HTTP ${status}).${detail ? ' ' + detail : ''}`, [
      'Check the terminal running uvicorn for the Python traceback.',
      'See the backend fix notes if this keeps happening.'
    ]);
    return;
  }
  const msg = body && typeof body.detail === 'string' ? body.detail : `Unexpected response (HTTP ${status}).`;
  showFormAlert(msg);
}

/* ---------- Results ---------- */
function showResult(record) {
  currentResult = record;
  $('#resultEmpty').hidden = true;
  $('#resultBody').hidden = false;

  const band = bandFor(record.score);
  $('#resScore').textContent = fmt(record.score);
  $('#resBand').textContent = band.label;
  $('#resBandText').textContent = band.text;
  $('#resTime').textContent = `Predicted ${when(record.createdAt)}`;

  $('#resDetails').innerHTML = FIELDS.map(f => {
    const v = record.inputs[f.key];
    return `<div><dt>${esc(f.label)}</dt><dd>${esc(v)}${f.unit ? ' ' + f.unit : ''}</dd></div>`;
  }).join('');

  const fill = $('#gaugeFill');
  fill.style.strokeDashoffset = 427.3;
  const pct = Math.min(Math.max(record.score / SCORE_MAX, 0), 1);
  requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.strokeDashoffset = 427.3 * (1 - pct); }));
}

$('#reuseBtn').addEventListener('click', () => {
  if (!currentResult) return;
  loadInputs(currentResult.inputs);
  location.hash = 'assess';
});

function loadInputs(inputs) {
  resetForm();
  FIELDS.forEach(f => { form.elements[f.key].value = inputs[f.key] ?? ''; });
  updateProgress();
}

/* ---------- History view ---------- */
function updateHistoryCount() { $('#historyCount').textContent = loadHistory().length; }

function renderHistory() {
  const list = loadHistory();
  const box = $('#historyList');
  $('#clearHistory').hidden = !list.length;
  if (!list.length) {
    box.innerHTML = '<div class="card empty"><h2>No saved predictions</h2><p>Results appear here after you run an assessment.</p><a class="btn primary" href="#assess">Start assessment</a></div>';
    return;
  }
  box.innerHTML = list.map(r => `
    <article class="card h-item" data-id="${r.id}">
      <div class="h-score">${fmt(r.score)}</div>
      <div>
        <strong>${esc(bandFor(r.score).label)}</strong>
        <small>${esc(when(r.createdAt))}</small>
        <small>Age ${esc(r.inputs.age)} · ${esc(r.inputs.academic_level)} · ${esc(r.inputs.most_used_platform)} · ${fmt(r.inputs.avg_daily_usage_hours)} h/day</small>
      </div>
      <div class="actions">
        <button class="btn ghost" data-act="view" type="button">View</button>
        <button class="btn danger" data-act="delete" type="button">Delete</button>
      </div>
    </article>`).join('');
}

$('#historyList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('[data-id]').dataset.id);
  const list = loadHistory();
  if (btn.dataset.act === 'view') {
    const rec = list.find(r => r.id === id);
    if (rec) { showResult(rec); location.hash = 'results'; }
  } else {
    saveHistory(list.filter(r => r.id !== id));
    updateHistoryCount(); renderHistory();
    toast('Prediction deleted.');
  }
});

$('#clearHistory').addEventListener('click', () => {
  if (!confirm('Delete all saved predictions from this browser?')) return;
  saveHistory([]);
  updateHistoryCount(); renderHistory();
  toast('History cleared.');
});

/* ---------- Dashboard ---------- */
function renderDashboard() {
  const list = loadHistory();
  const scores = list.map(r => r.score);
  $('#statCount').textContent = list.length;
  $('#statAvg').textContent = scores.length ? fmt(+(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : '–';
  $('#statMax').textContent = scores.length ? fmt(Math.max(...scores)) : '–';
  $('#statMin').textContent = scores.length ? fmt(Math.min(...scores)) : '–';

  const demo = $('.g-demo');
  if (scores.length) {
    $('#heroLatest').textContent = fmt(scores[0]);
    setTimeout(() => { demo.style.strokeDashoffset = 327 * (1 - Math.min(Math.max(scores[0] / SCORE_MAX, 0), 1)); }, 100);
  } else {
    $('#heroLatest').textContent = '–';
    demo.style.strokeDashoffset = 327;
  }

  const trend = $('#trendChart');
  if (!list.length) {
    trend.innerHTML = '<p class="trend-empty">Run an assessment to see your scores here.</p>';
  } else {
    const last = list.slice(0, 10).reverse();
    trend.innerHTML = last.map(r => `<div class="bar" style="height:0" data-h="${Math.max(4, Math.min(r.score / SCORE_MAX, 1) * 100)}" title="${esc(when(r.createdAt))}"><span>${fmt(r.score)}</span></div>`).join('');
    requestAnimationFrame(() => requestAnimationFrame(() => $$('.bar', trend).forEach(b => { b.style.height = b.dataset.h + '%'; })));
  }

  $('#recentList').innerHTML = list.length
    ? list.slice(0, 5).map(r => `<li><div><button type="button" data-id="${r.id}">${esc(bandFor(r.score).label)}</button><small>${esc(when(r.createdAt))}</small></div><span class="sc">${fmt(r.score)}</span></li>`).join('')
    : '<li><span class="empty-note">No assessments yet.</span></li>';
}

$('#recentList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  const rec = loadHistory().find(r => r.id === Number(btn.dataset.id));
  if (rec) { showResult(rec); location.hash = 'results'; }
});

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- Init ---------- */
populateSelects();
FIELDS.forEach(f => {
  const el = form.elements[f.key];
  el.addEventListener('input', () => { updateProgress(); if (el.closest('.field').classList.contains('invalid')) validateField(f); });
  el.addEventListener('blur', () => { if (el.value.trim() !== '') validateField(f); });
  el.addEventListener('change', () => { updateProgress(); validateField(f); });
});
$('#resetBtn').addEventListener('click', () => { resetForm(); toast('Form reset.'); });

updateHistoryCount();
updateProgress();
checkApi();
setInterval(checkApi, 30000);
const initial = loadHistory()[0];
if (initial) showResult(initial);
showView(location.hash.slice(1));
