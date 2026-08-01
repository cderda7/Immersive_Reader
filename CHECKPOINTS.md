# Checkpoint assessments

Graded against the take-home rubric (domain: **Building an immersive reading
experience for students**, UI/UX-focused). Scale is the rubric's own
three-point scale -- Worse / Comparable / Better than us -- not an invented
numeric grade, so checkpoints stay comparable to each other over time.

Categories: UI/UX Taste, Code quality, Depth of execution, Technical depth,
Focus/prioritisation, AI leverage & tooling.

---

## Checkpoint 1 -- 2026-07-31

**Grades**

| Category | Grade | Why |
| --- | --- | --- |
| UI/UX Taste | Comparable | Non-generic interaction design for the target audience: 3-tier syllable/word/paragraph highlighting, breath pauses matched to sentence/paragraph boundaries, tap-to-define cycling. Held back from "Better" by zero visual-polish verification (never seen deployed/rendered end-to-end by a judge) and by several interaction bugs that only got fixed today. |
| Code quality | Comparable, edging Better | Unusually thorough reasoning-in-comments on both sides of the stack, strict typing throughout, a deliberate fast/no-LLM vs. slow/LLM architectural split. Held back by zero automated tests anywhere, and two dead files (`problem_generator.py` empty stub, `read.py` kept only as a deprecated re-export). |
| Depth of execution | Comparable, at risk | Tap-to-define specifically is deep and complete (5-stage cycling, dictionary-grounded pronunciation + definition disambiguation, careful hold-vs-tap keyboard handling). But total scope already spans reading engine + tap-to-define + full-book library ingestion (R&J, Moby Dick) -- more breadth than the rubric's "tiny tiniest scope" instruction wants, before even considering new features. |
| Technical depth | Comparable to Better | Real edge-case rigor on tap-to-define: bounded Anthropic timeout/retries, an external hard deadline on DNS-hang-prone dictionary lookups, a from-scratch IPA syllabifier (maximal-onset rule) shipped today to remove an LLM dependency that was producing wrong pronunciations. The reading engine itself hasn't been stress-tested with the same rigor in our conversations, so I can't vouch for it at the same level yet. |
| Focus, prioritisation | Comparable, trending risky | One feature (tap-to-define) has real depth now. But scope has already grown to three areas, and both features being considered next (translation, Q&A forum) would each open a new area rather than deepen the existing one -- exactly what the rubric's "Worse" tier describes. |
| AI leverage, tooling | Better than us | The working pattern all session -- report a real bug, get an evidence-based root cause (often via an automated Playwright repro before/after), ship only once verified -- is a strong signal. Today's respelling fix is a good example of AI *judgment*, not just usage: removing an LLM call in favor of a deterministic, dictionary-grounded one specifically because the free-text answer had no ground truth to be checked against. |

**Flag, independent of the categories above:** the domain's own stated
requirement is "has to be deployed and no bugs." Nothing is deployed yet
(no Vercel/Render/Fly config found in the repo). This is the single
highest-priority open item regardless of how the six categories above
read, since an undeployed submission risks failing the domain's hard
requirement outright.

**Feasibility -- sentence translation:** technically low-risk. The
existing tap-to-define architecture (fast/slow split, per-key caching, one
well-scoped Claude call) generalizes directly -- add a request, cache by
(sentence, target_language). Estimate a few focused hours given the
established pattern. The real risk is strategic, not technical: it's a
new feature axis, and the rubric explicitly punishes breadth. Best
framing if pursued: present it as extending the SAME comprehension-support
feature (another mode within the existing tap/read flow) rather than a
separate one, so it reads as depth, not sprawl.

**Feasibility -- Q&A student forum (Supabase):** substantially bigger
lift and the highest-risk addition under consideration. It's the app's
first real persistent-data domain (schema, auth, RLS policies, ask/answer
UI, likely moderation) in a project that's been deliberately stateless so
far -- and it reads close to the exact "CRUD app... I don't want to see
that" pattern the rubric explicitly warns against. It also raises
deployment risk right when "no bugs" matters most: an entirely new
failure surface (auth, RLS misconfiguration, write races) with none of
the multi-iteration hardening tap-to-define has now gotten. Doesn't fit
well in the remaining time/rubric unless willing to treat it as THE one
deep feature and de-prioritize what's already built -- which would mean
partially abandoning depth already invested in tap-to-define, working
against the brief's "don't switch which one you're doing mid way."

**Recommended order:** (1) deploy now -- biggest gap against the domain's
own hard requirement, independent of feature grades; (2) a full bug pass
on what already exists -- "no bugs" is absolute, not comparative; (3)
only if time remains, one small deepening addition (translation, scoped
as an extension of the existing feature, not a new one); leave the Q&A
forum out of scope for this submission.
