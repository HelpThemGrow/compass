# Framework library

Every file in this folder is indexed and becomes part of the standard that
submitted documents are checked against, and the corpus that the "Ask the
framework" tab answers from.

## Adding documents

Drop files in. Sub-folders are fine and are kept in the citation path.
Supported: `.pdf`, `.docx`, `.md`, `.txt`, `.xlsx`, `.csv`.

Then either press **Rebuild index** on the Framework library tab, or just
restart — the index rebuilds automatically when it notices the files have
changed.

## What is in here now

Most of this set is still **illustrative**, written to demonstrate the
system end to end - replace each with your organisation's real policy
before relying on it for actual reviews. Three files are real, sourced from
Vibha's own D:\PM360\ documents (2026-09-07) and cited as such in their own
headers: `04_partner_due_diligence_policy.md`,
`14_project_proposal_review_process.md`, and the two files under
`templates/` (the template section lists are real; the guidance text inside
each section is reconstructed from the pitch deck and toolkit overview,
since the literal template files weren't supplied - see each file's header).
`rubrics/project_proposal.yaml` and `rubrics/project_renewal.yaml` were
updated to match.

| File | Covers | Status |
|---|---|---|
| `01_strategy_note.md` | mission, scope, portfolios, scaling | illustrative |
| `02_programme_design_standards.md` | evidence of need, theory of change, activity specification | illustrative |
| `03_mel_framework.md` | indicators, data collection, verification, attribution | illustrative |
| `04_partner_due_diligence_policy.md` | organisational identity, governance, financial health, track record, legal/regulatory standing, safeguarding, mission alignment, overall determination | **real** |
| `05_financial_policy.md` | budget format, overhead limits, disbursement, utilisation | illustrative |
| `06_government_engagement_protocol.md` | stakeholder mapping, permissions, institutionalisation | illustrative |
| `07_safeguarding_policy.md` | child protection, screening, incident reporting | illustrative |
| `08_risk_management_sop.md` | risk register, contextual risk, review | illustrative |
| `09_data_protection_policy.md` | children's data, consent, retention | illustrative |
| `10_compliance_policy.md` | FCRA, 12A/80G, CSR-1, POSH, filing deadlines | illustrative |
| `11_programme_management_sop.md` | work planning, staffing, operating systems | illustrative |
| `12_funding_policy.md` | what is funded, grant tiers, board approval | illustrative |
| `13_renewal_policy.md` | performance reporting, variance, next-phase targets | illustrative |
| `14_project_proposal_review_process.md` | the toolkit, roles, the 5-step gate process, both tracks' section structures, the scoring rubric, gate decisions | **real** |
| `templates/` | the blank templates staff are expected to write against | section lists real, guidance text reconstructed |

Note that criteria in the (still illustrative) `01`-`13` policies use
numeric thresholds - e.g. a 15% overhead ceiling - that do not appear
anywhere in Vibha's real documents and should not be treated as actual
Vibha policy until replaced.

## Writing framework documents that work well here

- **Use numbered headings** (`## 4. Overhead Limits`, `### 4.1 Ceiling`).
  Retrieved passages are cited by their heading, so good headings make findings
  checkable. Unstructured prose still works, but citations get vaguer.
- **State rules as numbers.** "Administrative costs must not exceed 15% of the
  total grant" is retrievable and quotable. "Administrative costs should be
  reasonable" is not, and the assistant will correctly refuse to invent a
  threshold.
- **Keep one topic per document.** Retrieval returns passages, not whole files;
  a single document covering six unrelated policies retrieves poorly.
- **Keep the numbers consistent across documents.** If the overhead ceiling
  appears in two policies, the assistant will cite both — and will flag the
  contradiction if they disagree.

## Keeping rubrics in step

Criteria in `rubrics/*.yaml` cite these documents by name and section in their
`framework_refs`. When you renumber a policy section, update the citing criteria
so reports keep pointing at the right clause. Nothing breaks if you forget — the
reference is displayed as text — but the citation goes stale.
