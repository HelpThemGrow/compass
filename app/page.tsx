import Script from "next/script";

export default function Home() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-row">
            <img src="/vibha-logo.png" alt="Vibha" className="brand-logo" />
            <strong>Compass</strong>
          </div>
          <span>Guiding teams through frameworks, compliance, and document standards</span>
        </div>
        <nav>
          <button data-tab="verify" className="active">
            <span className="nav-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m9 14 2 2 4-4"/></svg>
            </span>
            <span>Verify a document</span>
          </button>
          <button data-tab="generate">
            <span className="nav-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </span>
            <span>Generate a document</span>
          </button>
          <button data-tab="ask">
            <span className="nav-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/><path d="M12 8v4"/><path d="M12 15.5h.01"/></svg>
            </span>
            <span>Ask the framework</span>
          </button>
          <button data-tab="library">
            <span className="nav-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7"/><path d="M9 11h7"/></svg>
            </span>
            <span>Knowledge base</span>
          </button>
          <button data-tab="rubrics">
            <span className="nav-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.2"/><rect x="14" y="3" width="7" height="7" rx="1.2"/><rect x="3" y="14" width="7" height="7" rx="1.2"/><path d="m15 17.5 2 2 4-4"/></svg>
            </span>
            <span>Rubrics</span>
          </button>
          <button data-tab="history">
            <span className="nav-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>
            </span>
            <span>History</span>
          </button>
          <button data-tab="system">
            <span className="nav-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </span>
            <span>System</span>
          </button>
        </nav>
        <div className="sidebar-foot muted"></div>
      </aside>

      <main>

        {/* ================= VERIFY ================= */}
        <section id="tab-verify" className="tab active">
          <div className="page-head">
            <div>
              <h1>Check a document against the framework</h1>
              <p className="lead">Upload a proposal, renewal request, concept note or other programme document.
                It is checked against the written framework and returned with a rating, the gaps found,
                and what to fix.</p>
            </div>
          </div>

          <div className="panel" id="upload-panel">
            <input type="file" id="file" className="hidden" accept=".pdf,.docx,.txt,.md,.markdown,.xlsx,.csv" />
            <div className="drop" id="drop">
              <strong>Drop a file here, or click to choose</strong>
              <span className="muted">PDF, Word, Markdown, text, Excel or CSV &middot; up to 25&nbsp;MB</span>
              <div className="file" id="file-name"></div>
            </div>

            <div className="row" style={{ marginTop: "1rem" }}>
              <div className="field">
                <label htmlFor="rubric">Assess against</label>
                <select id="rubric"><option value="auto">Detect automatically</option></select>
              </div>
              <div className="field">
                <label htmlFor="evidence">Evidence passages per criterion</label>
                <select id="evidence">
                  <option value="2">2 — fastest</option>
                  <option value="3" defaultChecked>3 — balanced</option>
                  <option value="5">5 — most thorough</option>
                </select>
              </div>
              <label className="check"><input type="checkbox" id="skip-llm" /> Structural checks only (no model calls)</label>
              <button className="btn" id="run" disabled>Run review</button>
            </div>

            <div id="verify-status" className="progress hidden" style={{ marginTop: ".9rem" }}></div>
          </div>

          <div id="result"></div>
        </section>

        {/* ================= GENERATE ================= */}
        <section id="tab-generate" className="tab">
          <div className="page-head">
            <div>
              <h1>Draft a document from a description</h1>
              <p className="lead">Describe the project in your own words. The draft is written
                section by section using Vibha&apos;s own framework.</p>
            </div>
          </div>

          <div className="panel">
            <div className="row" style={{ marginTop: 0 }}>
              <div className="field" style={{ minWidth: "260px" }}>
                <label htmlFor="gen-type">Document type</label>
                <select id="gen-type"></select>
              </div>
            </div>

            <div className="field" style={{ marginTop: ".9rem" }}>
              <label htmlFor="gen-description">Describe the project</label>
              <textarea id="gen-description" rows={7}
                placeholder="e.g. A foundational literacy programme in 40 government primary schools in Sundarpur block, Grades 1-3, reaching 6,000 children over 18 months. A Learning Facilitator runs daily reading sessions per cluster of schools, with monthly teacher coaching. Baseline shows 20% of Grade 3 children reading at grade level; target is 50%. Budget around INR 1.2 crore, implementing partner is [organisation]."></textarea>
            </div>

            <div className="row" style={{ marginTop: ".8rem" }}>
              <button className="btn" id="gen-run">Generate draft</button>
              <span className="muted" id="gen-hint">Takes 1-3 minutes and uses several model calls.</span>
            </div>

            <div id="gen-status" className="progress hidden" style={{ marginTop: ".9rem" }}></div>
          </div>

          <div id="gen-result"></div>

          <div className="panel">
            <div className="panel-head">
              <h2>Recent drafts</h2>
              <button className="btn ghost small" id="gen-refresh-history">Refresh</button>
            </div>
            <div className="scroll-x"><table id="gen-history-table"></table></div>
          </div>
        </section>

        {/* ================= ASK ================= */}
        <section id="tab-ask" className="tab">
          <div className="page-head">
            <div>
              <h1>Ask a question about the framework</h1>
              <p className="lead">Answers are drawn only from the knowledge base and cite where each claim comes from.</p>
            </div>
            <div className="page-head-controls">
              <span className="muted" id="ask-meta"></span>
            </div>
          </div>

          <div className="panel">
            <div className="suggest" id="suggest"></div>
            <div className="chat" id="chat">
              <div className="empty" id="chat-empty">
                Ask anything covered by the documents in the knowledge base.<br />
                Answers are drawn only from those documents and cite where each claim comes from.
              </div>
            </div>
            <div className="ask-row">
              <textarea id="question" rows={2} placeholder="e.g. What is the ceiling on administrative costs, and when can it be exceeded?"></textarea>
              <button className="btn" id="ask">Ask</button>
            </div>
          </div>
        </section>

        {/* ================= LIBRARY ================= */}
        <section id="tab-library" className="tab">
          <div className="page-head">
            <div>
              <h1>Knowledge base</h1>
              <p className="lead">The standard everything is checked against: policies, design standards, SOPs and blank templates.</p>
            </div>
            <div className="page-head-controls">
              <button className="btn ghost small" id="lib-upload-btn">Add documents</button>
              <button className="btn small" id="rebuild">Rebuild index</button>
            </div>
          </div>

          <input type="file" id="lib-file" className="hidden" multiple accept=".pdf,.docx,.txt,.md,.markdown,.xlsx,.csv" />
          <div id="lib-stats" className="status-grid"></div>
          <div id="lib-notices"></div>

          <div className="panel">
            <div id="lib-status"></div>
            <div className="scroll-x"><table id="lib-table"></table></div>
          </div>
        </section>

        {/* ================= RUBRICS ================= */}
        <section id="tab-rubrics" className="tab">
          <div className="page-head">
            <div>
              <h1>Rubrics</h1>
              <p className="lead">The framework expressed as weighted, scoreable criteria — plain YAML in <code>rubrics/</code>, edited by programme staff. Every score traces back to a criterion here.</p>
            </div>
            <div className="page-head-controls">
              <select id="rubric-view"></select>
            </div>
          </div>
          <div id="rubric-detail"></div>
        </section>

        {/* ================= HISTORY ================= */}
        <section id="tab-history" className="tab">
          <div className="page-head">
            <div><h1>Past reviews</h1></div>
            <div className="page-head-controls">
              <button className="btn ghost small" id="refresh-history">Refresh</button>
            </div>
          </div>
          <div className="panel">
            <div className="scroll-x"><table id="history-table"></table></div>
          </div>
        </section>

        {/* ================= SYSTEM ================= */}
        <section id="tab-system" className="tab">
          <div className="page-head">
            <div><h1>System status</h1></div>
            <div className="page-head-controls">
              <button className="btn ghost small" id="refresh-health">Refresh</button>
            </div>
          </div>
          <div className="status-grid" id="health"></div>

          <div className="panel">
            <h2>How this works</h2>
            <p className="lead">Three layers run over every submission, in order.</p>
            <ol className="plain" style={{ paddingLeft: "1.3rem" }}>
              <li><b>Structural checks</b> — required sections, budget arithmetic, unfilled placeholders,
                registration and safeguarding declarations. Pure parsing: instant, free and identical every time.</li>
              <li><b>Rubric evaluation</b> — for each criterion the system searches the <em>submitted document</em>
                for evidence, then judges that evidence against the framework standard. Every score is tied to a
                quoted passage, so a finding can be checked or contested.</li>
              <li><b>Framework Q&amp;A</b> — retrieval-grounded answering over the knowledge base, used by the Ask tab.</li>
            </ol>
            <p className="lead">Embeddings and reranking run locally on the CPU, so indexing costs nothing.
              The hosted model is used only for judging and writing feedback, which keeps a full review to
              roughly ten API calls.</p>
            <div className="notice info">This is a pre-check against the written framework. It does not replace
              review by the programme committee or the board.</div>
          </div>
        </section>

      </main>
      <Script src="/app.js" strategy="afterInteractive" />
    </div>
  );
}
