# Compass

_Guiding teams through frameworks, compliance, and document standards._

Checks programme documents — funding proposals, renewal requests, concept notes —
against the organisation's written framework, and answers questions about that
framework.

A team member uploads a document. They get back a rating out of 100, what is
missing, what needs improving, and a downloadable review memo. Every finding is
tied to a numbered criterion and a quoted passage, so a programme manager can
contest a specific line and a board can see why a score is what it is.

This is the **Next.js / TypeScript port** of the original Python (FastAPI)
Compass app. It is a feature-for-feature replica — same three-layer
architecture, same rubrics and framework documents, same NVIDIA hosted model —
rebuilt on Node so the whole stack is JavaScript/TypeScript, no Python runtime
required.

---

## Architecture

Three layers, same as the original, ported 1:1:

### Layer 0 — Deterministic checks (no model)

Required sections present, budget tables that add up, unfilled `TBD` /
`[insert name]` placeholders, registration numbers, safeguarding declarations.
Pure parsing (`lib/deterministic.ts`) — instant, free, identical every run.

### Layer 1 — Rubric evaluation with inverted retrieval

The framework is compiled into a **rubric**: versioned, weighted criteria with
explicit 0–4 scoring anchors, stored as plain YAML (`rubrics/*.yaml`).
Retrieval runs backwards compared to a chatbot: the corpus is the *submitted
document*, each query is a *framework criterion*. Every score is anchored to a
verbatim quote or explicitly marked as having no evidence
(`lib/evaluate.ts`).

### Layer 2 — Framework Q&A (classic RAG)

Hybrid retrieval (dense + BM25, fused by Reciprocal Rank Fusion) over the
framework library, with a prompt that refuses to answer from general
knowledge (`lib/qa.ts`, `lib/store.ts`).

### Layer 3 — Generate a document from a description

The inverse of verification: describe a project in a few sentences and get a
first draft of a Project Charter, Project Proposal, or Concept Note, written
section by section against the same framework (`lib/generation.ts`). Project
Charter and Project Proposal fill the organisation's real `.docx` templates
directly via a hand-rolled OOXML engine (`lib/docxEngine.ts`); Concept Note
renders to a generic `.docx` built from scratch.

---

## Node/TypeScript equivalents of the Python stack

| Job | Python original | This port |
|---|---|---|
| Server | FastAPI | Next.js 15 App Router (Route Handlers) |
| LLM client | `openai` (Python SDK) | `openai` (Node SDK), same NVIDIA endpoint/model |
| Local embeddings | `fastembed` (ONNX) | `@xenova/transformers` (ONNX), `Xenova/bge-small-en-v1.5` |
| Vector math | NumPy | plain `Float32Array` |
| PDF extraction | `pypdf` | `pdf-parse` |
| Excel extraction | `openpyxl` | `xlsx` (SheetJS) |
| CSV parsing | `csv` stdlib | hand-written RFC-4180-ish parser |
| YAML | `PyYAML` | `js-yaml` |
| `.docx` template filling | `python-docx` + custom OOXML walking | `jszip` (unzip/rezip) + `@xmldom/xmldom` (DOM traversal) |
| Generic `.docx` generation | `python-docx` | `docx` (npm) |

Embeddings, reranking and lexical search all still run locally on the CPU —
indexing the framework library costs zero API calls, same as the original.
The hosted NVIDIA model is used only for judging criteria, writing feedback,
Q&A, and drafting generated documents.

`NVIDIA_API_KEY`, `NVIDIA_MODEL`, `NVIDIA_RPM_LIMIT`, `CREDIT_BUDGET`, and
every other setting use the exact same variable names as the Python app's
`.env`, so a working key/config drops straight into `.env.local`.

---

## Setup

```bash
npm install
cp .env.local.example .env.local
```

Open `.env.local` and paste a free API key from https://build.nvidia.com:

```
NVIDIA_API_KEY=nvapi-your-key-here
```

```bash
npm run dev
```

Open http://localhost:3000. Without a key the app still runs — structural
checks, search and the framework library all work; only criterion scoring,
Q&A and generation need it.

First embedding call downloads the local model weights (cached under
`data/.transformers-cache/`), then works offline.

**Production build:**

```bash
npm run build
npm run start
```

---

## Using it

**Verify a document** — drop in a PDF, Word file, Markdown, text, Excel or
CSV. The rubric is detected automatically; override it if the detection is
wrong. "Structural checks only" runs the whole thing with no API calls.

**Generate a document** — describe a project in a few sentences and get a
first draft of a Project Charter, Project Proposal, or Concept Note.

**Ask the framework** — questions about policy, with citations back to the
source document and section.

**Knowledge base** — add or remove framework documents and rebuild the
index. No restart needed.

**Rubrics** — see exactly what is being scored, with weights and criteria.

**History** — past reviews, re-openable, each with a downloadable memo.

**System** — model access, call budget, embedding backend, framework index
status.

---

## Adapting it to your framework

Two directories hold everything organisation-specific — neither requires
code changes.

### `frameworks/` — the source documents

Drop in policies, design standards, SOPs and blank templates
(`.pdf`, `.docx`, `.md`, `.txt`, `.xlsx`, `.csv`; sub-folders fine). This is
what Q&A answers from and what rubric criteria cite.

### `rubrics/*.yaml` — the scoreable framework

Each file is one document type — see `rubrics/project_proposal.yaml`,
`project_renewal.yaml`, `concept_note.yaml` for the shape: `sections`
(structural), `checks` (deterministic), `dimensions` → `criteria` (scored,
with weights, anchors and `framework_refs`). Rubrics reload on save; add a
new file and it appears in the dropdown.

### Adding a generated document type with its own template

Drop the `.docx` in `doc_templates/`, write a `generation/<type>.yaml`
describing its sections and tables (see `generation/project_charter.yaml`
for the full shape), and it appears in the document-type list automatically.

---

## Privacy

Everything runs locally except the judging, Q&A and generation calls to
NVIDIA. Uploaded documents are deleted from disk immediately after
processing; only the resulting JSON report is kept, in `data/reports/`.

**Document text, and anything typed into the Generate tab, is sent to
NVIDIA's hosted API.** Under NVIDIA's free developer tier that is not a
private endpoint.

- Do not upload documents, or describe projects, containing child-level
  personal data, identifiable photographs, health or disability records, or
  guardian contact details.
- Do not upload donor databases, HR records, government IDs, or credentials.
- Use anonymised or aggregated data wherever the document allows it.

`.env.local` is gitignored. It holds your API key — do not commit it.

---

## Project layout

```
app/
  layout.tsx, page.tsx, globals.css   the single-page UI shell
  api/                                Route Handlers - one per Python main.py endpoint
lib/
  config.ts          settings, all env-overridable
  llm.ts             NVIDIA client: rate limiting, credit ledger
  embeddings.ts       pluggable embedders (local ONNX / NVIDIA / hash) + reranker
  extract.ts          pdf, docx, xlsx, csv, md, txt -> text + heading outline
  chunking.ts         structure-aware chunking with overlap
  store.ts            vector store + BM25, fused by RRF
  ingest.ts           framework library indexing
  rubric.ts           rubric model, YAML loader, auto-detection
  deterministic.ts    layer 0 - checks that need no model
  evaluate.ts         layer 1 - inverted retrieval + rubric judging
  qa.ts               layer 2 - grounded framework Q&A
  generation.ts       layer 3 - draft a document from a description
  docxEngine.ts        generic corporate-.docx-template filler
  report.ts           Markdown review memo
  uploads.ts           shared upload helpers
public/app.js          UI logic (fetch calls against the Route Handlers above)
frameworks/            the framework corpus (replace with yours)
rubrics/                the scoreable framework, as YAML
generation/             generation guides for document types with a bespoke .docx template
doc_templates/          the actual corporate .docx templates generation renders into
samples/                test documents of varying quality
data/                   generated: index, reports, generated drafts, credit ledger (gitignored)
```

---

## Limitations

- **It checks documents, not projects.** A well-written proposal for a bad
  project scores well. This is a completeness and compliance pre-check, not
  a judgement of merit.
- **Scanned PDFs need OCR first.** No text layer means nothing to assess.
- **The rubric is the ceiling.** The system finds what the rubric asks
  about. Keeping rubrics current is ongoing programme work.
- **LLM judgements vary a little between runs.** Low temperature keeps this
  small, and the structural layer is exactly reproducible.
- **The free tier is not production capacity.** Rate-limited per minute;
  fine for a team, not for open submission at scale.
