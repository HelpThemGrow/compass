'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Shared KPI-card icon: one glyph, recoloured per card via the kpi-N accent
// classes already cycling on `.stat` (see style.css). A different icon per
// metric would need each call site to know what the metric means; this
// keeps the icon purely decorative and the accent colour doing the work of
// telling cards apart.
const STAT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg>';

function statIcon() {
  return `<span class="stat-ico">${STAT_ICON}</span>`;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    throw new Error(payload?.detail || `${res.status} ${res.statusText}`);
  }
  return payload;
}

// Mirrors the four bands in app/config.py's Settings.bands (85/70/55/0 ->
// Board Ready/Minor Revisions/Major Revisions/Not Ready) with four distinct
// colours, not three - collapsing "Minor Revisions" and "Major Revisions"
// into the same amber made two meaningfully different outcomes look
// identical at a glance, which defeats the point of colour-coding at all.
function bandClass(score) {
  if (score >= 85) return 'good';
  if (score >= 70) return 'note';
  if (score >= 55) return 'warn';
  return 'bad';
}

// A structural-only pass must not be coloured like an endorsement — it says
// nothing about the substance of the document.
const isStructuralOnly = (r) => r.band === 'Structural check only';

function severityClass(sev) {
  return { blocker: 'bad', major: 'warn', minor: 'info', info: 'info' }[sev] || 'info';
}

// ---------------------------------------------------------------- tabs
$$('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('nav button').forEach((b) => b.classList.remove('active'));
    $$('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'library') loadLibrary();
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'system') loadHealth();
    if (btn.dataset.tab === 'rubrics') loadRubricDetail();
    if (btn.dataset.tab === 'generate') loadGenerateHistory();
  });
});

// ---------------------------------------------------------------- upload
let chosenFile = null;
const drop = $('#drop');
const fileInput = $('#file');

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) setFile(fileInput.files[0]);
});

function setFile(file) {
  chosenFile = file;
  $('#file-name').textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
  $('#run').disabled = false;
}

// ---------------------------------------------------------------- verify
$('#run').addEventListener('click', async () => {
  if (!chosenFile) return;

  const status = $('#verify-status');
  const skipLlm = $('#skip-llm').checked;
  $('#run').disabled = true;
  $('#result').innerHTML = '';
  status.classList.remove('hidden');

  const steps = skipLlm
    ? ['Reading the document…', 'Running structural checks…']
    : ['Reading the document…', 'Indexing the submission…', 'Gathering evidence per criterion…',
       'Judging against the framework…', 'Writing the review…'];
  let step = 0;
  status.innerHTML = `<span class="spinner"></span> ${steps[0]}`;
  const ticker = setInterval(() => {
    step = Math.min(step + 1, steps.length - 1);
    status.innerHTML = `<span class="spinner"></span> ${steps[step]}`;
  }, skipLlm ? 1200 : 7000);

  const body = new FormData();
  body.append('file', chosenFile);
  body.append('rubric_id', $('#rubric').value);
  body.append('skip_llm', skipLlm ? 'true' : 'false');
  body.append('evidence_per_criterion', $('#evidence').value);

  try {
    const result = await api('/api/verify', { method: 'POST', body });
    renderResult(result);
  } catch (err) {
    $('#result').innerHTML = `<div class="panel"><div class="notice bad">
      <b>Review failed.</b><br>${esc(err.message)}</div></div>`;
  } finally {
    clearInterval(ticker);
    status.classList.add('hidden');
    $('#run').disabled = false;
  }
});

function dial(score, neutral = false) {
  const r = 56, c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const colour = neutral ? '#8a93a8' : { good: '#28a745', warn: '#f4a62a', bad: '#d9534f' }[bandClass(score)];
  return `<div class="dial">
    <svg width="132" height="132" viewBox="0 0 132 132">
      <circle cx="66" cy="66" r="${r}" fill="none" stroke="#eef1f6" stroke-width="11"/>
      <circle cx="66" cy="66" r="${r}" fill="none" stroke="${colour}" stroke-width="11"
        stroke-linecap="round" stroke-dasharray="${(c * pct).toFixed(1)} ${c.toFixed(1)}"/>
    </svg>
    <div class="val"><b>${score}</b><span>out of 100</span></div>
  </div>`;
}

function renderResult(r) {
  const s = r.summary || {};
  const det = r.deterministic || {};
  const failures = (det.findings || []).filter((f) => f.status !== 'pass');

  const parts = [];

  // --- headline
  parts.push(`<div class="panel">
    <div class="score-head">
      ${dial(r.overall_score, isStructuralOnly(r))}
      <div style="flex:1;min-width:240px">
        <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.35rem">
          <h2 style="margin:0">${esc(r.filename)}</h2>
          <span class="badge ${isStructuralOnly(r) ? 'info' : bandClass(r.overall_score)}">${esc(r.band)}</span>
        </div>
        <p class="lead" style="margin-bottom:.4rem">${esc(r.band_note)}</p>
        <div class="muted">Assessed against <b>${esc(r.rubric_name)}</b> v${esc(r.rubric_version)}
          ${r.auto_selected ? '(detected automatically)' : ''} · ${esc(r.created_at)}</div>
        <div class="sub-scores">
          <div>Framework criteria<br><b>${r.content_score}</b>/100</div>
          <div>Structural completeness<br><b>${r.structure_score}</b>/100</div>
          <div>Words<br><b>${(det.word_count || 0).toLocaleString()}</b></div>
          <div>Model calls used<br><b>${r.stats?.api_calls ?? 0}</b></div>
        </div>
      </div>
    </div>
    ${r.capped_reason ? `<div class="notice bad"><b>Rating capped.</b> ${esc(r.capped_reason)}</div>` : ''}
    ${r.auto_selected && r.rubric_suggestions?.[0]?.close_call ? `<div class="notice">
      <b>Rubric detection was not clear-cut.</b> This was assessed as
      <b>${esc(r.rubric_name)}</b>, but it also resembles
      ${esc(r.rubric_suggestions[1]?.name || 'another document type')}.
      If that is the wrong standard, choose the rubric explicitly above and run it again.</div>` : ''}
    ${(r.warnings || []).map((w) => `<div class="notice">${esc(w)}</div>`).join('')}
    <div class="toolbar" style="margin-top:.9rem">
      <a class="btn ghost small" style="text-decoration:none"
         href="/api/evaluations/${encodeURIComponent(r.id)}/markdown">Download review memo</a>
      ${(r.rubric_suggestions || []).length > 1 ? `<button class="btn ghost small" id="rerun-other">Reassess with a different rubric</button>` : ''}
    </div>
  </div>`);

  // --- summary + actions
  if (s.overall_summary) {
    parts.push(`<div class="panel">
      <h2>Summary</h2>
      <p class="lead">${esc(s.overall_summary)}</p>
      ${(s.strengths || []).length ? `<h3 style="margin-top:1rem">What is working</h3>
        <ul class="plain">${s.strengths.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${(s.priority_actions || []).length ? `<h3 style="margin-top:1rem">Do these first</h3>
        <ol class="actions">${s.priority_actions.map((a) => `<li>
          <b>${esc(a.action)}</b>
          <span class="why">${esc(a.why_it_matters)}</span>
          <div class="tags">
            <span class="tag">effort: ${esc(a.effort || 'medium')}</span>
            ${(a.criterion_ids || []).map((id) => `<span class="tag">${esc(id)}</span>`).join('')}
          </div></li>`).join('')}</ol>` : ''}
      ${s.reviewer_note ? `<div class="notice info" style="margin-top:1rem">
        <b>For the reviewing committee:</b> ${esc(s.reviewer_note)}</div>` : ''}
    </div>`);
  }

  // --- dimensions
  const structural = isStructuralOnly(r);
  if ((r.dimensions || []).length) {
    parts.push(`<div class="panel">
      <h2>Scores by dimension</h2>
      ${structural ? '<p class="muted">Content was not scored, so these are not real dimension results.</p>' : ''}
      <div class="bars">${r.dimensions.map((d) => `
        <div class="bar-row">
          <span>${esc(d.name)} <span class="muted">· weight ${d.weight}</span></span>
          <div class="bar-track"><div class="bar-fill ${structural ? 'info' : bandClass(d.score)}" style="width:${structural ? 0 : d.score}%"></div></div>
          <span class="n">${structural ? '—' : d.score}</span>
        </div>`).join('')}</div>
    </div>`);
  }

  // --- structural
  parts.push(`<div class="panel">
    <h2>Structural checks</h2>
    <p class="muted">Run by parsing the document. No model involved, so these results are identical every time.</p>
    ${(det.missing_sections || []).length ? `<div class="notice bad">
      <b>Missing required sections:</b> ${det.missing_sections.map(esc).join(', ')}</div>` : ''}
    ${failures.length ? `<div class="scroll-x"><table>
      <tr><th>Severity</th><th>Check</th><th>Finding</th><th>Fix</th></tr>
      ${failures.map((f) => `<tr>
        <td><span class="badge ${severityClass(f.severity)}">${esc(f.severity)}</span></td>
        <td>${esc(f.title)}</td>
        <td>${esc(f.detail)}</td>
        <td>${esc(f.remedy)}</td>
      </tr>`).join('')}
    </table></div>` : '<p class="lead">All structural checks passed.</p>'}
  </div>`);

  // --- criteria
  if ((r.dimensions || []).length) {
    parts.push(`<div class="panel">
      <div class="panel-head"><h2>Criterion-by-criterion findings</h2>
        <button class="btn ghost small" id="expand-all">Expand all</button></div>
      ${r.dimensions.map((d) => {
        const weak = d.criteria.filter((c) => c.score < 3 && c.verdict !== 'not_applicable').length;
        const countBadge = structural
          ? '<span class="badge info">not scored</span>'
          : weak
            ? `<span class="badge bad">${weak} to address</span>`
            : '<span class="badge good">clear</span>';
        return `<details class="dim" ${weak && !structural ? 'open' : ''}>
          <summary>
            <span>${esc(d.name)}</span>
            <span class="spacer"></span>
            ${countBadge}
            <span class="badge ${structural ? 'info' : bandClass(d.score)}">${structural ? '—' : `${d.score}/100`}</span>
          </summary>
          <div class="dim-body">${d.criteria.map((c) => renderCriterion(c, structural)).join('')}</div>
        </details>`;
      }).join('')}
    </div>`);
  }

  $('#result').innerHTML = parts.join('');

  const expand = $('#expand-all');
  if (expand) {
    expand.addEventListener('click', () => {
      const items = $$('details.dim');
      const openAll = items.some((d) => !d.open);
      items.forEach((d) => { d.open = openAll; });
      expand.textContent = openAll ? 'Collapse all' : 'Expand all';
    });
  }

  const rerun = $('#rerun-other');
  if (rerun) {
    rerun.addEventListener('click', () => {
      $('#rubric').focus();
      $('#upload-panel').scrollIntoView({ behavior: 'smooth' });
    });
  }

  $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const VERDICTS = {
  met: ['Met', 'good'],
  partially_met: ['Partially met', 'warn'],
  not_met: ['Not met', 'bad'],
  not_applicable: ['Not applicable', 'info'],
};

function renderCriterion(c, structural = false) {
  // A structural-only run never judged content: every criterion carries the
  // same fallback score=0/verdict=not_met (app/evaluate.py's
  // _fallback_results), which would otherwise render identically to a
  // document that was actually judged and failed everything. Showing "not
  // assessed" instead of a fabricated-looking "Not met · 0/4" is the whole
  // point of the "Structural check only" band existing.
  const [label, cls] = structural ? ['Not assessed', 'info'] : (VERDICTS[c.verdict] || ['Unknown', 'info']);
  const pill = structural ? 'na' : c.verdict === 'not_applicable' ? 'na' : `s${c.score}`;
  const pillText = structural ? '—' : c.verdict === 'not_applicable' ? 'n/a' : `${c.score}/4`;
  return `<div class="crit">
    <div class="crit-head">
      <code>${esc(c.id)}</code>
      <span class="pill ${pill}">${pillText}</span>
      <span class="badge ${cls}">${label}</span>
      ${structural ? '' : `<span class="muted">confidence: ${esc(c.confidence)}</span>`}
    </div>
    <div class="req">${esc(c.requirement)}</div>
    ${c.evidence_verified === false
      ? `<blockquote><i>The quote cited for this criterion could not be located in the document.
           This score is unverified — check it by hand.</i></blockquote>`
      : c.evidence_quote
        ? `<blockquote>${esc(c.evidence_quote)}${c.evidence_location ? `<cite>found in: ${esc(c.evidence_location)}</cite>` : ''}</blockquote>`
        : `<blockquote><i>No supporting evidence found in the document.</i></blockquote>`}
    ${c.gap ? `<div class="kv"><b>Gap:</b> ${esc(c.gap)}</div>` : ''}
    ${c.recommended_fix ? `<div class="kv"><b>Fix:</b> ${esc(c.recommended_fix)}</div>` : ''}
    ${(c.framework_refs || []).length ? `<div class="muted" style="margin-top:.3rem">Framework: ${c.framework_refs.map(esc).join('; ')}</div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- generate
async function loadGenerateTypes() {
  try {
    const data = await api('/api/generate/types');
    const types = data.types || [];
    $('#gen-type').innerHTML = types.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')
      || '<option value="">No document types available</option>';
  } catch (err) {
    $('#gen-type').innerHTML = `<option value="">${esc(err.message)}</option>`;
  }
}

$('#gen-run').addEventListener('click', async () => {
  const docType = $('#gen-type').value;
  const description = $('#gen-description').value.trim();
  if (!docType) return;
  if (description.length < 20) {
    alert('Add a bit more detail — at least a couple of sentences about the project.');
    return;
  }

  const btn = $('#gen-run');
  const status = $('#gen-status');
  btn.disabled = true;
  $('#gen-result').innerHTML = '';
  status.classList.remove('hidden');

  const steps = ['Reading the framework for relevant standards…', 'Drafting the narrative sections…',
    'Drafting objectives, scope and constraints…', 'Drafting deliverables and governance…',
    'Filling in identification and tables…', 'Finishing up…'];
  let step = 0;
  status.innerHTML = `<span class="spinner"></span> ${steps[0]}`;
  const ticker = setInterval(() => {
    step = Math.min(step + 1, steps.length - 1);
    status.innerHTML = `<span class="spinner"></span> ${steps[step]}`;
  }, 18000);

  try {
    const result = await api('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc_type: docType, description }),
    });
    renderGenerated(result);
    loadGenerateHistory();
  } catch (err) {
    $('#gen-result').innerHTML = `<div class="panel"><div class="notice bad">
      <b>Generation failed.</b><br>${esc(err.message)}</div></div>`;
  } finally {
    clearInterval(ticker);
    status.classList.add('hidden');
    btn.disabled = false;
  }
});

function renderGenerated(doc) {
  const parts = [];

  parts.push(`<div class="panel">
    <div class="panel-head">
      <h2 style="margin:0">${esc(doc.doc_name)}</h2>
    </div>
    <p class="muted">Drafted ${esc(doc.created_at)} · ${doc.stats?.api_calls ?? 0} model call(s) ·
      ${doc.stats?.elapsed_s ?? '?'}s</p>
    ${(doc.warnings || []).map((w) => `<div class="notice">${esc(w)}</div>`).join('')}
    <div class="notice info">This is a first draft, grounded in the framework where it could be —
      review it, fill in anything marked "To be determined" or "Pending", and have it checked by
      the Programme Committee before relying on it. If you download the Word file, right-click the
      Table of Contents and choose "Update Field" to refresh the page numbers.</div>
    <div class="toolbar" style="margin-top:.7rem">
      <a class="btn small" style="text-decoration:none" href="/api/generate/${encodeURIComponent(doc.id)}/docx">Download Word (.docx)</a>
      <a class="btn ghost small" style="text-decoration:none" href="/api/generate/${encodeURIComponent(doc.id)}/markdown">Download Markdown</a>
    </div>
  </div>`);

  parts.push(`<div class="panel">
    <h2>Draft content</h2>
    ${Object.entries(doc.blocks || {}).map(([bid, block]) => {
      const value = doc.content?.[bid];
      if (!value || (Array.isArray(value) && !value.length) || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length)) return '';
      let body = '';
      if (block.kind === 'bullets') {
        body = `<ul class="plain">${value.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
      } else if (block.kind === 'key_value') {
        body = `<table>${(block.fields || []).filter((f) => value[f]).map((f) => `
          <tr><th style="white-space:nowrap">${esc(f)}</th><td>${esc(value[f])}</td></tr>`).join('')}</table>`;
      } else if (block.kind === 'list') {
        const cols = block.columns || [];
        body = `<div class="scroll-x"><table>
          <tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
          ${value.map((row) => `<tr>${cols.map((c) => `<td>${esc(row[c] ?? '')}</td>`).join('')}</tr>`).join('')}
        </table></div>`;
      }
      return `<details class="dim" open><summary><span>${esc(block.heading)}</span></summary>
        <div class="dim-body">${body}</div></details>`;
    }).join('')}
  </div>`);

  $('#gen-result').innerHTML = parts.join('');
  $('#gen-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadGenerateHistory() {
  try {
    const data = await api('/api/generate');
    const rows = data.generated || [];
    $('#gen-history-table').innerHTML = rows.length
      ? '<tr><th>Type</th><th>Description</th><th>Created</th><th></th></tr>' +
        rows.map((g) => `<tr>
          <td>${esc(g.doc_name)}</td>
          <td>${esc(g.description)}${g.description?.length >= 140 ? '…' : ''}</td>
          <td>${esc(g.created_at)}</td>
          <td style="text-align:right">
            <button class="btn ghost small" data-open-gen="${esc(g.id)}">Open</button>
            <a class="btn ghost small" style="text-decoration:none" href="/api/generate/${encodeURIComponent(g.id)}/docx">Word</a>
          </td>
        </tr>`).join('')
      : '<tr><td class="empty">No drafts generated yet.</td></tr>';

    $$('#gen-history-table button[data-open-gen]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const full = await api(`/api/generate/${encodeURIComponent(b.dataset.openGen)}`);
        renderGenerated(full);
      } catch (err) {
        alert(err.message);
      }
    }));
  } catch (err) {
    $('#gen-history-table').innerHTML = `<tr><td class="empty">${esc(err.message)}</td></tr>`;
  }
}

loadGenerateTypes();

// ---------------------------------------------------------------- ask
const history = [];

const SUGGESTIONS = [
  'What is the ceiling on administrative costs?',
  'What must a partner provide for due diligence?',
  'When is an independent evaluation mandatory?',
  'What are the child data protection requirements?',
  'What must a theory of change contain?',
  'What permissions are needed to work in government schools?',
];

function initSuggestions() {
  $('#suggest').innerHTML = SUGGESTIONS.map((q) => `<button>${esc(q)}</button>`).join('');
  $$('#suggest button').forEach((b) => b.addEventListener('click', () => {
    $('#question').value = b.textContent;
    askQuestion();
  }));
}

$('#ask').addEventListener('click', askQuestion);
$('#question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) askQuestion();
});

async function askQuestion() {
  const box = $('#question');
  const question = box.value.trim();
  if (!question) return;

  $('#chat-empty')?.remove();
  const chat = $('#chat');
  box.value = '';
  $('#ask').disabled = true;

  chat.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(question)}</div>`);
  const pending = document.createElement('div');
  pending.className = 'msg bot';
  pending.innerHTML = '<span class="spinner"></span> Searching the framework…';
  chat.appendChild(pending);
  chat.scrollTop = chat.scrollHeight;

  try {
    const res = await api('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history: history.slice(-8) }),
    });

    pending.innerHTML = `<div class="body">${linkCitations(res.answer)}</div>
      ${(res.sources || []).length ? `<details class="sources">
        <summary>${res.sources.length} source passage(s) used</summary>
        ${res.sources.map((s) => `<div class="src">
          <div class="cite">[${s.n}] ${esc(s.citation)}</div>
          <div class="ex">${esc(s.excerpt)}${s.excerpt.length >= 500 ? '…' : ''}</div>
        </div>`).join('')}
      </details>` : ''}`;

    history.push({ role: 'user', content: question });
    history.push({ role: 'assistant', content: res.answer });
    $('#ask-meta').textContent = `${res.credits_remaining} model calls remaining in budget`;
  } catch (err) {
    pending.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  } finally {
    $('#ask').disabled = false;
    chat.scrollTop = chat.scrollHeight;
  }
}

function linkCitations(text) {
  return esc(text).replace(/\[(\d+)\]/g, '<code>[$1]</code>');
}

// ---------------------------------------------------------------- library
$('#rebuild').addEventListener('click', async () => {
  const btn = $('#rebuild');
  btn.disabled = true;
  const started = Date.now();
  const tick = () => {
    const secs = Math.round((Date.now() - started) / 1000);
    const note = secs < 8
      ? 'Re-indexing the framework library…'
      : `Re-indexing the framework library… ${secs}s elapsed. Embeddings run locally on the CPU — ` +
        `a library this size can take a few minutes the first time, or after adding documents. ` +
        `Once built, the index is cached and loads instantly.`;
    $('#lib-status').innerHTML = `<div class="progress"><span class="spinner"></span> ${note}</div>`;
  };
  tick();
  const ticker = setInterval(tick, 1000);
  try {
    await api('/api/framework/rebuild', { method: 'POST' });
    await loadLibrary();
  } catch (err) {
    $('#lib-status').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  } finally {
    clearInterval(ticker);
    btn.disabled = false;
  }
});

$('#lib-upload-btn').addEventListener('click', () => $('#lib-file').click());
$('#lib-file').addEventListener('change', async () => {
  const files = $('#lib-file').files;
  if (!files.length) return;
  const body = new FormData();
  Array.from(files).forEach((f) => body.append('files', f));
  $('#lib-status').innerHTML = '<div class="progress"><span class="spinner"></span> Uploading and re-indexing…</div>';
  try {
    const res = await api('/api/framework/upload', { method: 'POST', body });
    if (res.errors?.length) {
      $('#lib-status').innerHTML = `<div class="notice bad">${res.errors.map(esc).join('<br>')}</div>`;
    }
    await loadLibrary();
  } catch (err) {
    $('#lib-status').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  }
  $('#lib-file').value = '';
});

let _libPollTimer = null;

async function loadLibrary() {
  try {
    const data = await api('/api/framework');
    const st = data.status || {};
    const stale = st.stale;
    const building = st.state === 'building';

    $('#lib-stats').innerHTML = `
        <div class="stat">${statIcon()}<div class="k">Index</div>
          <div class="v">${esc(st.state || 'unknown')}</div>
          <div class="d">${st.built_at ? `built ${esc(st.built_at)}` : 'not built yet'}</div>
          <span class="badge ${st.state === 'ready' ? 'good' : 'warn'}">${st.state === 'ready' ? 'Ready' : esc(st.state || 'Unknown')}</span></div>
        <div class="stat">${statIcon()}<div class="k">Documents</div><div class="v">${st.documents ?? 0}</div>
          <div class="d">${st.chunks ?? 0} searchable passages</div></div>
        <div class="stat">${statIcon()}<div class="k">Files on disk</div><div class="v">${st.files_on_disk ?? 0}</div>
          <div class="d">${esc(st.frameworks_dir || '')}</div></div>`;

    $('#lib-notices').innerHTML = `
      ${building ? '<div class="notice"><span class="spinner"></span> Indexing the framework library in the background — this page will update automatically. Embeddings run locally on the CPU, so a first build (or one after adding documents) can take a few minutes; searches and reviews will work once it finishes.</div>' : ''}
      ${stale && !building ? '<div class="notice"><b>The index is out of date.</b> Files have changed since it was last built. Press Rebuild index.</div>' : ''}
      ${(st.errors || []).length ? `<div class="notice bad"><b>Could not index:</b><br>${st.errors.map(esc).join('<br>')}</div>` : ''}`;

    clearTimeout(_libPollTimer);
    if (building) {
      _libPollTimer = setTimeout(loadLibrary, 3000);
    }

    const docs = data.documents || [];
    $('#lib-table').innerHTML = docs.length
      ? `<tr><th>Document</th><th>Size</th><th>Modified</th><th></th></tr>` +
        docs.map((d) => `<tr>
          <td>${esc(d.path)}</td><td>${d.size_kb} KB</td><td>${esc(d.modified)}</td>
          <td style="text-align:right"><button class="btn danger small" data-del="${esc(d.path)}">Remove</button></td>
        </tr>`).join('')
      : '<tr><td class="empty">No framework documents yet. Add your policies, standards and templates.</td></tr>';

    $$('#lib-table button[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Remove "${b.dataset.del}" from the framework library?\n\nThis deletes the file from disk.`)) return;
      b.disabled = true;
      try {
        await api(`/api/framework/document?path=${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
        await loadLibrary();
      } catch (err) {
        alert(err.message);
        b.disabled = false;
      }
    }));
  } catch (err) {
    $('#lib-status').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------- rubrics
async function loadRubrics() {
  try {
    const data = await api('/api/rubrics');
    const list = data.rubrics || [];
    $('#rubric').innerHTML = '<option value="auto">Detect automatically</option>' +
      list.map((r) => `<option value="${esc(r.id)}">${esc(r.name)} (v${esc(r.version)})</option>`).join('');
    $('#rubric-view').innerHTML = list.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  } catch { /* surfaced on the System tab */ }
}

async function loadRubricDetail() {
  const id = $('#rubric-view').value;
  if (!id) { $('#rubric-detail').innerHTML = '<div class="empty">No rubrics defined.</div>'; return; }
  try {
    const r = await api(`/api/rubrics/${encodeURIComponent(id)}`);
    $('#rubric-detail').innerHTML = `
      <div class="status-grid" style="margin:1rem 0">
        <div class="stat">${statIcon()}<div class="k">Version</div><div class="v">${esc(r.version)}</div></div>
        <div class="stat">${statIcon()}<div class="k">Dimensions</div><div class="v">${r.dimension_count}</div></div>
        <div class="stat">${statIcon()}<div class="k">Criteria</div><div class="v">${r.criteria_count}</div></div>
        <div class="stat">${statIcon()}<div class="k">Structural checks</div><div class="v">${r.section_count + r.check_count}</div></div>
      </div>
      <p class="lead">${esc(r.description)}</p>
      <h3 style="margin-top:1.2rem">Weighting</h3>
      <div class="bars">${r.dimensions.map((d) => {
        const total = r.dimensions.reduce((a, x) => a + x.weight, 0) || 1;
        const pct = (d.weight / total * 100);
        return `<div class="bar-row">
          <span>${esc(d.name)} <span class="muted">· ${d.criteria} criteria</span></span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          <span class="n">${pct.toFixed(0)}%</span>
        </div>`;
      }).join('')}</div>
      <h3 style="margin-top:1.4rem">Required sections</h3>
      <p class="muted">${r.sections.filter((s) => s.required).map((s) => esc(s.title)).join(' · ') || 'none'}</p>
      <h3 style="margin-top:1.2rem">Criteria</h3>
      <div class="scroll-x"><table>
        <tr><th>ID</th><th>Dimension</th><th>Requirement</th><th>Weight</th></tr>
        ${r.criteria.map((c) => `<tr>
          <td><code>${esc(c.id)}</code>${c.critical ? ' <span class="badge bad">critical</span>' : ''}</td>
          <td>${esc(c.dimension)}</td>
          <td>${esc(c.requirement)}<div class="muted">${(c.framework_refs || []).map(esc).join('; ')}</div></td>
          <td>${c.weight}</td>
        </tr>`).join('')}
      </table></div>`;
  } catch (err) {
    $('#rubric-detail').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  }
}
$('#rubric-view').addEventListener('change', loadRubricDetail);

// ---------------------------------------------------------------- history
$('#refresh-history').addEventListener('click', loadHistory);

async function loadHistory() {
  try {
    const data = await api('/api/evaluations');
    const rows = data.evaluations || [];
    $('#history-table').innerHTML = rows.length
      ? '<tr><th>Document</th><th>Rubric</th><th>Score</th><th>Rating</th><th>Reviewed</th><th></th></tr>' +
        rows.map((e) => `<tr>
          <td>${esc(e.filename)}</td>
          <td>${esc(e.rubric_name)}</td>
          <td><b>${e.overall_score}</b></td>
          <td><span class="badge ${e.band === 'Structural check only' ? 'info' : bandClass(e.overall_score)}">${esc(e.band)}</span></td>
          <td>${esc(e.created_at)}</td>
          <td style="text-align:right">
            <button class="btn ghost small" data-open="${esc(e.id)}">Open</button>
            <a class="btn ghost small" style="text-decoration:none"
               href="/api/evaluations/${encodeURIComponent(e.id)}/markdown">Memo</a>
          </td>
        </tr>`).join('')
      : '<tr><td class="empty">No reviews yet.</td></tr>';

    $$('#history-table button[data-open]').forEach((b) => b.addEventListener('click', async () => {
      const full = await api(`/api/evaluations/${encodeURIComponent(b.dataset.open)}`);
      $$('nav button').forEach((x) => x.classList.remove('active'));
      $$('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelector('nav button[data-tab="verify"]').classList.add('active');
      $('#tab-verify').classList.add('active');
      renderResult(full);
    }));
  } catch (err) {
    $('#history-table').innerHTML = `<tr><td class="empty">${esc(err.message)}</td></tr>`;
  }
}

// ---------------------------------------------------------------- health
$('#refresh-health').addEventListener('click', loadHealth);

async function loadHealth() {
  try {
    const h = await api('/api/health');
    const llm = h.llm || {};
    const led = llm.ledger || {};
    const emb = h.embeddings || {};
    const fw = h.framework || {};
    const usedPct = led.budget ? Math.round(led.calls / led.budget * 100) : 0;

    $('#health').innerHTML = `
      <div class="stat">${statIcon()}<div class="k">Model access</div>
        <div class="v">${llm.configured ? 'Connected' : 'No API key'}</div>
        <div class="d">${esc(llm.model || '')}</div>
        <span class="badge ${llm.configured ? 'good' : 'bad'}">${llm.configured ? 'Connected' : 'No API key'}</span></div>
      <div class="stat">${statIcon()}<div class="k">Call budget</div>
        <div class="v">${led.remaining ?? 0} left</div>
        <div class="d">${led.calls ?? 0} of ${led.budget ?? 0} used (${usedPct}%)</div></div>
      <div class="stat">${statIcon()}<div class="k">Embeddings</div>
        <div class="v">${esc(emb.backend || '?')} · ${emb.dim || 0}d</div>
        <div class="d">${esc(emb.detail || '')}</div>
        <span class="badge ${emb.backend === 'hash' ? 'warn' : 'good'}">${emb.backend === 'hash' ? 'Fallback' : 'Local'}</span></div>
      <div class="stat">${statIcon()}<div class="k">Framework index</div>
        <div class="v">${esc(fw.state || '?')}</div>
        <div class="d">${fw.documents ?? 0} documents · ${fw.chunks ?? 0} passages</div>
        <span class="badge ${fw.state === 'ready' ? 'good' : 'warn'}">${fw.state === 'ready' ? 'Ready' : esc(fw.state || 'Unknown')}</span></div>
      <div class="stat">${statIcon()}<div class="k">Rubrics</div>
        <div class="v">${(h.rubrics || []).length}</div>
        <div class="d">${(h.rubrics || []).reduce((a, r) => a + r.criteria_count, 0)} criteria total</div></div>
      <div class="stat">${statIcon()}<div class="k">Accepted files</div>
        <div class="v">${(h.supported_types || []).length} types</div>
        <div class="d">${(h.supported_types || []).join(' ')}</div></div>`;

    if (!llm.configured) {
      $('#health').insertAdjacentHTML('afterend',
        `<div class="notice" style="grid-column:1/-1">No <code>NVIDIA_API_KEY</code> is set.
         Structural checks and search work without it; criterion scoring and Q&amp;A need a key.
         Copy <code>.env.example</code> to <code>.env</code> and add a free key from build.nvidia.com,
         then restart the server.</div>`);
    }
    if (h.rubric_error) {
      $('#health').insertAdjacentHTML('afterend',
        `<div class="notice bad" style="grid-column:1/-1"><b>Rubric problem:</b> ${esc(h.rubric_error)}</div>`);
    }
  } catch (err) {
    $('#health').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------- boot
initSuggestions();
loadRubrics().then(loadRubricDetail);
loadHealth();
