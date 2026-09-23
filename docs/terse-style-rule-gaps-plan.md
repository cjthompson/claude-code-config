# Terse output style — close ten rule gaps

## Context

A real chat reply written under the Terse style came out as eight markdown-free
prose paragraphs. Auditing it against `plugins/output-styles/output-styles/terse.md`
split the violations into two groups:

- **Rules the model simply ignored** — the labeled-block hard trigger (`:41`),
  bolded conclusion (`:9`), the whole emphasis mechanism (`:105–111`), backticks
  (`:97`), finding-before-process (`:17`). No file change fixes these.
- **Rules whose wording let the output through on a literal read.** These are the
  file's problem, and they are what this plan fixes.

A Sonnet agent was then given the current rules plus four draft amendments and
asked to reformat the same prose. The amendments worked — the reply became
scannable, the buried bug finding led its block, and both self-assessment
paragraphs vanished. But the run exposed three further gaps: labels drifted into
sentences, the backtick rule was ignored again even with structure in place, and
the model invented a carve-out to an amendment that had none.

Outcome intended: a Terse style whose structural rules cannot be satisfied
cosmetically, and which names first-person retrospective prose as banned — the
single largest source of bloat in the sample, and the one thing no current rule
catches.

## Scope

One file: `plugins/output-styles/output-styles/terse.md`.

Not touched: `plugins/output-styles/output-styles/concise.md` (sibling style,
same gaps may exist, out of scope), `docs/output-style-terse-instructions.md`
(unloaded design-note ancestor — leave stale).

## The ten amendments

Amendments 1–7 close gaps found by auditing the sample and one Sonnet reformat
run. Amendments 8–10 were added afterwards at the user's direction: a required
terminal status block (8), an enumeration exception the block's own examples
needed (9), and acronym expansion (10), prompted by `MOD` going unexplained
through every summary in this session.

### 1. Label lead-ins — any terminating punctuation

`terse.md:41` bans a "bold or plain-text lead-in **with a colon or dash**." The
sample's `What changed.` and `Why it's safe, not just simpler.` used periods and
escaped. Broaden to cover any punctuation or none — state plainly that a period
ends a lead-in as surely as a colon does.

### 2. `:56` must not be dodgeable by declining structure

`:56` (facts never comma-joined, no comma-packed parentheticals) sits under
"Rules of the block" at `:53`. With no block present it does not formally bite,
so `byte-identical … for all 21 documents, and the 9 mirrored pages still pass`
and `(that stays)` were legal.

**Narrowed from the first draft.** Making the rule flatly global breaks two rules
already in the file:

- `:9` requires a bolded conclusion, and this sample's honest headline has two
  components (`push_form` no longer unwraps **and** a real bug surfaced). A global
  no-`and` rule mutilates it.
- `:89` ("clarity floor wins over brevity") is the file's own tiebreaker. A new
  absolute must not silently outrank it.

So state the rule as **closure of the escape route, not a global ban**: a reply
carrying 2+ discrete findings becomes a labeled block per `:41`, and inside a
block `:56` applies — therefore writing prose instead of a block is not a way
around one-fact-per-line. Exempt the single bolded conclusion sentence at `:9`
explicitly, and leave `:89` as the tiebreaker.

### 3. Scope note instead of an absolute — and re-examine the evidence

The first draft of this amendment said "there is no exception: a contrast between
two things is two facts." That was based on the Sonnet run keeping
`` `SKILL.md` is read by whoever runs the sync; `CLAUDE.md` by whoever writes the prose ``
on one line while calling it "a single contrastive fact."

**That diagnosis is probably wrong.** The line uses a semicolon, not a comma, and
`:56` bans commas. It is one parallel contrast, not two independent findings —
arguably compliance. Do not write an absolute to close it.

What this amendment reduces to: a short scope sentence attached to `:56` making
clear the rule follows from the block trigger rather than being optional, plus a
pointer to `:89` for genuine clarity conflicts. If, after amendment 2 lands, this
adds nothing beyond amendment 2's wording, drop it rather than padding the file.

### 4. Detail menu applies after any answer

`:124` reads "After any brief answer." The sample was not brief, so the missing
`More on:` menu had an escape hatch. Drop "brief".

### 5. Ban first-person retrospective and self-assessment prose

`:19–21` enumerates stock phrases about tool use and throat-clearing. It does not
cover what actually bloated the sample: `The key thing I'd been missing…` and the
entire `Worth naming that I nearly filed my own failing test as a false alarm…
The reflex to distrust the test before the code…` paragraph. Neither changes a
user decision (`:11`).

Add a fourth banned category under **No Narration or Filler**, covering: what you
had been missing, what you nearly got wrong, the reflex or instinct that misled
you, what the episode taught you, what a class of mistake has cost the session.
Include the operative test — *if a sentence describes your own reasoning or
character rather than the state of the code, cut it* — and the one carry-through:
if your own misstep changed the outcome, state the consequence as one `›` fact
and stop.

### 6. A label must be a category noun, not a sentence

The Sonnet run produced `` # `Why it's safe, not just simpler`: `` and
`` # `Bug found and fixed`: `` — the original prose lead-ins wrapped in
backticks. `:70` lists category nouns (`Reason`, `Verified`, `Result`) but never
requires a label to *be* one, so amendment 1 is satisfiable by cosmetic
requoting.

Tighten the **Label** bullet at `:55`: at most three words, not a sentence, does
not read as a claim. Give the contrast — `` # `Reason`: `` not
`` # `Why it's safe, not just simpler`: `` — and the disposal rule: if the label
asserts something, it is a fact, so move it into a `›` line and pick a category
noun for the heading.

**Do not ban verbs.** `:70`'s own recommended-labels list includes
`Leave unchanged`, a verb phrase. A "no verb" rule would outlaw a label the file
recommends and force a second edit to `:70`. "Not a sentence, does not read as a
claim" already rejects `` # `Why it's safe, not just simpler`: `` and
`` # `Bug found and fixed`: `` while keeping `Leave unchanged` legal.

### 7. Restate the backtick rule where the violation happens

`:97` is a lone bullet in **Compression Rules** and was ignored in both runs —
`active/` → `completed/` stayed bare even after the reply was fully structured.
The failures occur inside `›` facts, so add an **Identifiers** bullet to "Rules
of the block" requiring every path, command, branch, filename, directory,
function, version, commit sha, and UI label inside a fact to be backticked,
bare directory names included.

### 8. Required terminal `Result` block

Replies that report work — changes made, changes suggested, or research and
findings — must close with a status roll-up. Both of the user's sample replies end
without one: the reader has to reconstruct state from prose.

Settled with the user:

- **Label is `` # `Result`: ``**, not `Current state`. Chosen because a reply may
  carry findings or research with no changes at all, and `Result` covers both.
- **Status symbol family** (`✓` done, `✗` failed, `○` pending, `●` active) from
  `:78`, not `›` facts. This is the deciding advantage: the block can show what
  has *not* happened, so a pending push is visible rather than merely absent.
- **Extensible list.** `files edited`, `changes committed`, `commits pushed`,
  `suggested changes awaiting approval` are the common cases, not a closed set —
  `tests run`, `PR opened`, `no changes made` are equally valid lines.
- **Placement:** last block in the reply, immediately before the `More on:` menu
  if one is present.

Also settled with the user:

- **`Result` is reserved for the terminal block.** Remove it from `:70`'s
  general useful-labels list, so a `` # `Result`: `` heading always means "this is
  the end of the reply, here is the state." Costs one label from the general pool
  and buys an unambiguous terminator.
- **`:96` folds into this rule.** It ("Always state outcome state explicitly:
  whether changes were made, committed, amended, pushed, tested, or left
  untouched") mandates the same information as prose with no required format.
  Shrink it to a pointer at this block: its enumeration becomes the block's
  example lines, and "if nothing changed, say so" becomes a `○ no changes made`
  line. The file was already rewritten once (`4fec1cd`) to dedupe rules — do not
  reintroduce two rules for one requirement.

Two items to check while writing:

- **`:81` "don't mix symbol families"** already forces this block to be
  all-status-symbol. Confirm the rule text doesn't accidentally permit a `›` line
  inside it.
- **Edit ordering inside "Rules of the block."** Amendments 6 (Label bullet at
  `:55`), 7 (new Identifiers bullet in the same list), and 8 (removing `Result`
  from the useful-labels line at `:70`) all land in this one section. They touch
  different lines and do not overlap, but apply them in order 6 → 7 → 8 and
  re-read the section afterwards; line numbers shift as bullets are added. Confirm
  no amendment still cites `Result` as a general-purpose label once 8 lands.

Worked example — the terminal block for a reply reporting partly-live work:

    # `Result`:
    ✓ 7 commits, tree clean at `7e6db18` — all fixes verified present in `HEAD`
    ✓ wrapping fix live in Notion — 9 pages re-pushed, each byte-verified
    ○ table/fence folds — correct-by-test, never run through a live pull
    ✗ `apply-pull` blocked — remote-change detection doesn't work
    ○ 2 pages pending — the other session's `active/` → `completed/` reparent

(The original sample said `2 MOD pages` here. Amendment 10 would require that
token be expanded; since its expansion is unknown, the example avoids it.)

Note what the `✗` and `○` lines do: they report state that prose omits entirely.
That is the reason for choosing the status family over `›` facts.

**Interaction with amendment 5.** Both of the user's sample replies close with
banned retrospective prose (`Bug 3 is worth naming`, `That's now three times this
session…`). The `Result` block is where such a paragraph's surviving content goes
— the code-relevant residue becomes one status line (`✓ Bug 3 fixed — the first
attempt patched the warning suppressor, not the failing path`) and the
self-assessment is cut. State this link explicitly in the rule text so amendment 5
reads as a redirect rather than pure deletion.

### 9. `:56` cannot distinguish an enumeration from a comma-joined finding

Surfaced while drafting amendment 8's example blocks. `:56` bans comma-packed
content outright — "a comma-packed `(like this, this, and this)` is the same
violation … if a claim needs an example, give the single clearest one."

But *one* fact whose object is a homogeneous list has no lawful form. In the
user's second sample the unhandled constructs are callouts, toggles, columns,
mentions, `<span>`, `<br>` — a single finding with six instances. Splitting it
into six `›` lines is absurd; naming only "the single clearest one" loses real
information about coverage.

Amend `:56` to distinguish the two: commas may not join **discrete findings**, but
may enumerate **instances of one finding**. This is the same class of defect as
amendment 3 — an absolute written without its legitimate exception — so write the
exception in rather than leaving it to be invented at reply time.

### 10. Expand every acronym on first use

**Every acronym, initialism, and abbreviation is expanded the first time it
appears in a reply**, parenthesized and once only — not just internal or
project-specific ones. Applies everywhere in the reply, including inside the
`Result` block.

Why the rule is deliberately blunt. The narrower first draft said "internal status
codes, flags, and project abbreviations" — which requires deciding whether a given
token is decodable from context. **That is precisely the judgment that failed.**
`MOD` appeared in both sample replies and in every summary built from them; it was
classified as contextually obvious, decoded as "modified — a per-document sync
status code in the family of git's `A`/`M`/`D`", and that reading was wrong. It is
a project abbreviation. Every contextual signal supported the incorrect expansion,
and the user had to ask.

A rule conditioned on "is this one obvious?" delegates the decision to the same
faculty that got it wrong. A rule with no condition cannot be misapplied that way.

Distinct from two rules that look like they should cover it:

- `:13` (use the exact identifier when the identifier IS the answer) — the failure
  was not using `MOD`; that is the correct token. It is never having said what it
  expands to.
- `:89` (clarity floor) — `2 MOD pages` is perfectly precise *to a reader who
  already knows*. A floor phrased around ambiguity does not fire on a term that is
  unambiguous to its author.

Keep expansions to three or four words, parenthesized, once per reply. This is not
a license for explanatory prose, which the rest of the file exists to suppress.

**Resolved: blanket rule plus a closed allowlist.** The user's directive was "all
acronyms," and that is the default. But a literal absolute with no exception would
produce `opened a PR (pull request)` in routine replies, and amendment 3 of this
very plan documents what happens next: an absolute written without its legitimate
exception gets an exception invented at reply time — which is exactly what Sonnet
did to amendment 2. So write the exception in now rather than earning amendment 11.

Exempt list, explicit and closed: `PR`, `CI`, `API`, `URL`, `HTML`, `CSS`, `HTTP`,
`JSON`, `SQL`. Enumeration is the whole point — "well-known ones are exempt" would
reintroduce the judgment call this amendment exists to remove. Anything not on the
list gets expanded, with no appeal to obviousness.

**Worked example uses a known token, not `MOD`.** `MOD` remains unresolved: the
Notion page is behind auth, `WebFetch` hit a redirect loop, and no Notion tool is
available in this profile. The URL slug reads `Multiplayer-Onboarding-Project`,
which does not abbreviate to `MOD`. It stays in this plan as the incident that
motivated the rule, but the rule's own example must use a token whose expansion is
certain — e.g. `RTK (Rust Token Killer)`, `TUI (terminal user interface)`, or
`MCP (Model Context Protocol)`, all documented in this repo.

**Interaction with amendment 9.** Amendment 9 permits commas to enumerate
instances of one finding. Where such an enumeration contains acronyms, amendment 10
still applies to each on its first appearance — but if that would put three or more
parenthetical glosses inside a single `›` line, the line has become an
explanation rather than a fact: split it or name fewer instances. Amendment 10 wins
on the gloss; the resulting bloat is resolved by cutting, not by skipping glosses.

## Also recommended (not one of the ten — drop if unwanted)

Nothing was *cut* in the Sonnet reformat. It is far more scannable but no
shorter; `` # `Convention documented`: `` spends three `›` lines on one fact plus
its rationale. The compression half of `:37` still does not bite once structure
is in place. A one-line addition to `:37` would close it: structure is not a
substitute for cutting — after structuring, delete any `›` line that does not
change a decision, and collapse a fact plus its rationale into one line where the
rationale is a clause.

## Verification

The mandated skill-editing loop in `CLAUDE.md` ("Skill Editing Verification")
triggers only on a `SKILL.md` carrying a `model:` field in frontmatter.
`terse.md` is an output style with no `model:` field, so that loop does not
formally apply — but run its shape anyway, since it is exactly the harness that
produced these findings:

1. **Sonnet reformat, two samples.** Dispatch a Sonnet sub-agent with the amended
   `terse.md` verbatim plus **two** inputs: the original eight-paragraph prose
   sample (preserved in this conversation), and a second, previously unseen prose
   sample drawn from `docs/output-style-examples.json` or
   `docs/output-style-examples-long.json`. Instruct it to use no tools and return
   raw markdown for each.

   The second sample is the point. Gaps 6 and 7 only surfaced because the
   amendments met fresh conditions; re-running the same input confirms the seven
   named defects are patched but cannot expose a round-three
   cosmetic-satisfaction gap, which is the failure mode this style keeps hitting.
2. **Check all ten defects individually** in the first sample's output:
   1. period-terminated lead-ins became `` # `Label`: `` headings
   2. no comma-joined facts, and no prose route taken around the block trigger
   3. the bolded conclusion is still allowed to carry two clauses
   4. a `More on:` menu is present despite the answer not being brief
   5. both retrospective paragraphs gone, the sync-path-symmetry fact retained
   6. every label is a short category label, not a sentence or a claim —
      `Leave unchanged` still legal
   7. `active/`, `completed/`, `ccb799d`, `push_form`, `reflow`, `<table ...>` all
      backticked
   8. reply ends with a `` # `Result`: `` block using only `✓`/`✗`/`○`/`●`, placed
      before the `More on:` menu; `Result` appears nowhere as a mid-reply label
   9. a homogeneous enumeration survives on one line without being split into six
   10. every acronym outside the closed allowlist is expanded on first use
3. **Opus verify.** Pass the amended file and both Sonnet outputs to an Opus
   sub-agent for APPROVED / NEEDS REVISION. Loop on NEEDS REVISION. Ask it
   specifically whether the second sample reveals a new way to satisfy the
   structural rules cosmetically.
4. **Live check.** The style is installed from `plugins/`, so it takes effect via
   the marketplace with no reinstall. Switch to Terse and confirm the amended
   file loads and renders.

## Post-merge tasks (project `CLAUDE.md`)

1. Bump the patch version in `package.json`.
2. Add a `CHANGELOG.md` entry under today's date with the new version heading.
3. Check `README.md:80–88` (the user-facing style table) — update the Terse
   description only if these amendments change how it reads.
4. **Do not** prompt to run `npm run install-packages`. This is a `plugins/`
   change; those install via the marketplace and take effect automatically.

## Branching and PR

Per global `CLAUDE.md`, quoted rather than paraphrased:

> **Default: every PR is cut from the repo's default branch and targets it.** A PR
> is "independently shippable" only if it can be reviewed and merged on its own,
> in any order relative to my other open PRs, and contains working reviewable
> code (not a bare migration or empty stub). Never slice a single function across
> PRs.

All ten amendments edit one file and interlock — amendment 1 is defeatable
without 6, 2 without 3, and 8's worked examples are unwritable without 9 and 10.
They are one reviewable unit, so this is a single PR, not ten.

Checkpoint 2, in writing:

- `ct/terse-style-rule-gaps` ← `origin/main` (default branch — no proof needed)

Cut it after `git fetch`, from the ref resolved by
`git symbolic-ref --short refs/remotes/origin/HEAD`, not from the current
working tree.

Load the `pre-push-check` skill before pushing, and again after the PR is created.

## This plan file

Written to `docs/terse-style-rule-gaps-plan.md`, not the `~/.claude/plans/` path
the harness designated — that directory is denied by permissions and declared
off-limits by the project `CLAUDE.md`, which (like the global one) directs plan
files to the repo's `docs/`.

`docs/` is **untracked** (`?? docs/` at session start). On
`ct/terse-style-rule-gaps`, a `git add -A` would sweep this plan into the PR.
Decide before the first commit: add `docs/` to `.git/info/exclude` (local-only,
per the global `CLAUDE.md` preference for not touching a shared `.gitignore`
unasked), or stage the file deliberately.
