me:
ATLAS is a very large collaboration. We use a lot of different ways to document things. Wiki pages, GitHub, ppt and pdf presentations, etc. Thigs get obsolete, and info is hard to find. We tried to put all of it into a vector store and use RAG to chat with it but it doesn’t work very well. I am imagining a different kind of system: an AI librarian, to whom people would give their knowledge, documents, etc. The librarian would extract only things it does not know already, check if the new info contradicts with some existing knowledge and if it does clarify what is right, generate metadata (time, provenance, classification), then store it. People would be able to ask for specific info, a report, instructions how to do something, description of a system,etc. Technically, how would you make that librarian? Give me just high level overview.

you:
The core move is shifting work from query time to write time. Plain RAG fails on your corpus because the corpus itself is contradictory and stale — no retriever fixes that. The librarian's real job is maintaining a curated knowledge base, and answering is the easy part.

Knowledge representation

Don't store chunks. Store claims: atomic, self-contained statements, each with its own record. Fields: subject entity, the assertion, provenance (who, which doc, which page), ingest time, valid-from/valid-until, confidence, classification, supersedes/contradicts links. Originals stay in a content-addressed blob store; claims point back at them. Entities and relations (systems, services, people, sites, procedures) form a light graph over the claims.

Bitemporal is the key trick for your obsolescence problem: "when was this true" is separate from "when did we learn it." Nothing gets deleted, only superseded.

Ingest pipeline

Parse (docs, slides, wiki, GitHub, meeting notes) → normalized text + structure.
Extract candidate claims with an LLM, each tied to a span in the source.
Novelty check: retrieve near-neighbors per claim; drop exact dupes, keep refinements.
Contradiction check: for surviving claims, pull the relevant existing claims and adjudicate. Most conflicts are actually temporal (the old thing was true in 2021), and those the system can resolve itself by closing the old claim's validity window.
True conflicts go to a review queue — and here's the part worth building well: route the question back to the author of the contradicted claim, not to a generic curator. "Ilija said X in March; you're saying Y. Which holds?" That's how you get the collaboration to do the curation for you.
Commit as a versioned write with full audit trail.

Query side

Agentic retrieval rather than one-shot RAG: a planner decomposes the question, then uses several tools — graph traversal, BM25, vector search, and structured filters (system, time window, status=current) — iterates, and synthesizes with citations to claims and through to original sources. Answer templates differ by intent: a "how do I" needs procedure claims in order; "describe this system" needs a graph walk. Always surface staleness and any unresolved conflict rather than silently picking a side.

Two things people skip

Decay: volatile claims (endpoints, versions, who's on call) get a TTL and auto-generate re-verification pings. Evaluation: a gold set of questions with known-correct current answers, run as regression tests on every pipeline change — otherwise you can't tell whether a change helped.

One question shapes a lot of this: is contribution mostly push (people deliberately submit to the librarian) or do you also need to pull continuously from existing Twiki/GitHub/Indico? The second case makes ingest volume large enough that automated conflict resolution quality becomes the whole ballgame, and changes how I'd stage the build.

me:
I expect that amount of pushes would be larger at the beginning until knowledge is built, then pulls would take over.

you:
That read/write flip is the main thing that should drive the build order — though I want to make sure I've got your meaning, since "pull" could be people pulling answers out or the system pulling from Twiki/Indico/GitHub. Taking it as read-vs-write:

Bootstrap phase (write-heavy)

Optimize for throughput of adjudication, not for answer polish. The bottleneck will be humans resolving conflicts, and if that step is slow or annoying the whole thing dies in month two.

Seed with a bulk import of the existing corpus first, even if messy. People contribute far better by correcting than by authoring from scratch — "here are the 40 claims we extracted about Rucio subscriptions, which are wrong?" gets a response; "tell us about Rucio" doesn't.
Batch conflicts by owner and by system, deliver them where people already are (Mattermost, e-group mail, a GGUS-adjacent queue), and make the default action one click.
Accept lower precision. During bootstrap it's fine to store both sides of an unresolved conflict and mark it disputed. Answers can say "two accounts exist."
Run extraction with a cheap model plus a strong model only on conflict adjudication; the cost profile is inverted from what you'd guess.

Steady state (read-heavy)

Now the risk shifts from coverage to silent rot, and connector-driven pulls become the main write path.

Watchers on Twiki/GitHub/Indico that diff and re-extract only changed material.
TTL-driven re-verification on volatile claims, since nobody will proactively tell you an endpoint moved.
Mine the query log: questions that return nothing or return disputed claims are your highest-value ingest targets, and they tell you exactly where to spend human attention.
Answer quality work (intent routing, graph traversal for system descriptions, ordered procedure assembly) matters much more here than during bootstrap.

Consequence for the schema

Design the claim record now for both phases even if you only implement the first — validity windows, TTL, disputed status, owner attribution. Retrofitting bitemporality onto a live store is miserable.

One thing worth deciding early: who counts as authoritative when two people disagree? ATLAS has a natural answer in the form of activity coordinators and system experts, and wiring that role map in from the start turns most adjudication into automatic routing rather than a judgment call the system has to make.


me: 
Right, we have coordinators but even without them two people with opposing claims can be contacted and asked to check and report who’s right.


you:
Agreed, and that peer path is probably better than authority anyway — coordinators are a fallback for timeouts, not the primary route. A few mechanics that decide whether it works in practice:

**Offer "both are right" as a first-class answer.** In a collaboration this size, most apparent contradictions aren't factual disputes — they're scope mismatches. Different site, different release, different data period, one person describing the analysis workflow and the other the production one. If the resolution UI only asks "which is correct," people will pick one and you'll destroy a true claim. Give them: A is right / B is right / both true under different conditions / neither, here's the real answer. The third option is the one that fires most often, and it resolves by adding qualifiers to both claims rather than retiring either.

**The disputed state has to be livable.** Replies will take days or never come. So a disputed claim stays queryable and answers surface both versions with attribution — that's usually more useful to the asker than a confident wrong answer. Timeout ladder: ping the two authors, then after some window route to the system's coordinator, then park it as permanently disputed and let query traffic re-raise it if anyone actually cares.

**Budget human attention hard.** One digest per person per week, ranked by how often the disputed claim gets hit by real queries. A contradiction nobody ever asks about doesn't deserve an email. This also gives you a natural prioritization signal during bootstrap when the conflict queue will be enormous.

The thing I'd watch is whether a resolution is itself a claim — I'd say yes, stored with its own provenance ("resolved by X and Y on date, superseding Z"), because in two years someone will re-litigate the same point and the librarian should be able to say it was already settled and by whom.

me:
I agree. How to do this technically?

you:
**System of record: Postgres.** Resist the urge to reach for a graph DB or a dedicated vector DB. One transactional store keeps claims, edges, and embeddings consistent, and you need transactions because a supersession touches several rows at once.

Core tables:

- `documents` — content hash, URI, fetched_at, parser version, raw blob in S3/EOS
- `claims` — text, canonical form, subject entity, `valid_from`/`valid_to`, `asserted_at`/`retracted_at`, status (`active|disputed|superseded|retired`), confidence, TTL, owner, classification
- `claim_provenance` — claim → document + character span + extractor version (many-to-many; the same claim can be attested by several sources, and that's a confidence signal)
- `claim_edges` — typed: `supersedes`, `contradicts`, `refines`, `qualifies`, `resolves`
- `entities` + `aliases`

Embeddings in pgvector with an HNSW index. BM25 in Elasticsearch, which you already run. Graph traversal via recursive CTEs over `claim_edges` — at claim-count scale of millions this is fine and saves you a second consistency domain.

**Entity backbone from CRIC.** You already have an authoritative registry of sites, services, and endpoints. Link extracted entities against it rather than inventing your own namespace, and you get free disambiguation plus a join path into live operational state.

**Ingest as idempotent stages.** A durable queue (pgqueuer or River on the same Postgres, or Argo Workflows since you're on Kubernetes) with each stage keyed by `content_hash + prompt_version + model_version`. That key is what makes re-extraction affordable when you improve a prompt: you replay only what changed, and you can diff old against new claims before committing.

Extraction uses constrained/structured decoding against a JSON schema, and the schema must require span offsets. A claim without a byte range back into a document is unverifiable and you'll regret accepting it.

**Conflict detection is two-stage retrieval then classification.** For each candidate claim, pull neighbors by hybrid search filtered to the same entity, then classify each pair into: duplicate, refinement, temporal supersession, scope qualification, true conflict. Cheap model for triage, strong model only on the last two categories. Temporal supersessions auto-commit by closing the old claim's `valid_to`; scope and true conflicts open a `dispute` record with the two claim IDs and both owners.

**Resolutions as claims.** Store the verdict as a row with its own provenance and `resolves` edges to the disputed pair. Then "was this already settled?" is a graph query, not tribal memory.

**Serve it as an MCP server.** You already have RUCIO, CRIC, GGUS, ES connectors, so the librarian becomes another one, and the agentic query loop gets tools: `search_claims`, `traverse_entity`, `get_timeline`, `get_disputes`, `fetch_source`. This also means people reach it from Claude directly instead of you building a chat UI, and the same tools back a Mattermost bot.

**Eval harness from day one.** A frozen gold set of question → expected-current-answer pairs, run on every prompt or model change, scoring retrieval recall and answer correctness separately so you know which half regressed.

Want me to sketch the actual claim schema as DDL, or work through the conflict-classification prompt and its output contract? Those are the two pieces where the details matter most.

me: 
If I serve it as an MCP, how will people add knowledge to it?

you:
Same server, write tools alongside the read ones. MCP isn't read-only — `submit_knowledge`, `submit_document`, `resolve_dispute`, `confirm_claim` are just tools with side effects. So the flow becomes: someone is already chatting with Claude about how the DDM transfer retry works, figures it out, and says "save this" — the agent calls `submit_knowledge` with the text plus the conversation as provenance. That's the highest-value capture path you have, because it catches knowledge at the moment it's articulated rather than asking someone to go write a wiki page later.

A few design points:

**Write tools must return the extraction for confirmation, not just an ack.** `submit_knowledge` runs extraction synchronously, returns "I got these 6 claims, 2 are new, 1 conflicts with something Marco said in June," and the person approves or corrects in the same turn. Submitting into a black box kills trust immediately. For a large document, return a job ID and have the agent poll.

**Identity is the hard part.** MCP servers behind Claude get an OAuth token; you need that to carry a real CERN identity so provenance and ownership mean something. Route auth through CERN SSO so the token maps to a person, then to their e-groups, which gives you both attribution and classification enforcement for free. Anonymous writes are worse than no writes.

**MCP is one ingest path of several.** It covers ad-hoc human submission well, but you also want:

- **Connectors/watchers** — Twiki, GitHub, Indico, JIRA, GGUS tickets. Scheduled diff-and-extract. This becomes the volume leader in steady state.
- **A Mattermost bot** — same tools, different front end. `@librarian remember this` on a thread is lower friction than anything else in your environment, and ATLAS conversations already happen there.
- **A plain HTTP API + CLI** — for bulk import, and so people can wire it into their own scripts.
- **Email drop** — surprisingly effective for forwarding a thread that contains the answer.

All of them funnel into the same queue and the same extraction stages; MCP tools are a thin layer over that API, not a parallel implementation.

**Guard the write path.** Rate limits per identity, a quarantine state for claims from unverified submitters until a second source or a human confirms, and an audit log of every write with the submitting token. An agent that can write to shared knowledge is an agent that can poison it, including by accident — if someone's Claude session hallucinates a detail and helpfully "saves" it, you want that traceable and reversible. Never let extraction from a submitted conversation treat the *assistant's* statements as authoritative; only what the human asserted counts.
