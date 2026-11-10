# Design notes

This is an independent reference implementation, written from scratch for demonstration; not extracted from any production system. Providers, models, tenants and prices are fictional (prices are made up).

These notes explain *why* the code is shaped the way it is. For *what* it does, see the [README](../README.md); for exact behavior, the tests in `tests/` are the specification.

## 1. Goals and non-goals

Goals:

1. Make "which model should serve this request" an inspectable, versioned, testable policy decision.
2. Make every decision explain itself in a form a program can consume.
3. Make policy changes testable against recorded traffic before deployment.
4. Keep the core small enough to read in an afternoon: zero runtime dependencies, no framework.

Non-goals: being a production proxy, measuring real model quality, or optimizing throughput. There is no network code in this repository.

## 2. Data model

Three inputs drive routing, and all of them are plain JSON:

- **Catalog**: the universe of routes. A route is `provider/model`. Entries carry capabilities, context limit, fictional per-million-token prices, a latency *class* (`fast`, `standard`, `slow`), region tags and a quality *tier* (1 to 5).
- **Request descriptor**: not the request payload, only what routing needs to know about it. The router never sees prompt text. This keeps decision logs free of user content and makes replay possible without storing payloads.
- **Policy**: weights, deny rules, per-task-class overrides, fallback depth, and optional budget and breaker sections.

Latency and quality are deliberately coarse labels rather than numbers. A catalog is a statement of intent ("this model is in the fast class"); real measurements would feed a catalog-generation process, not the router. Fine-grained numbers would imply precision this project cannot honestly claim.

## 3. The routing function

```
routeRequest(request, policy, catalog, context) -> RoutingDecision
```

It is a pure function. `context` carries the two environmental inputs that legitimately change over time: which providers' breakers are open, and the tenant's budget window. Both are echoed into the decision (`decision.context`), so a stored decision contains everything needed to re-derive it. A test re-routes every record of the bundled log from its own recorded context and asserts the result equals the recorded decision exactly.

### 3.1 Hard constraints before scoring

Constraints and preferences are different things and are kept apart. A model that lacks a required capability, does not fit in context, is outside the required region, is denied, or is over the cost ceiling is not "less preferred"; it is not allowed. Folding those into a score invites the failure mode where a heavily weighted preference outvotes a requirement.

Every rule is evaluated for every candidate (no early exit), so an eliminated model carries *all* of its reasons. This costs nothing at this scale and makes the explanation honest: "this model was eliminated for A" would be misleading if it also failed B and C, because relaxing A alone would not make it eligible.

Reason codes are a closed enumeration (`ELIMINATION_CODES`), each with a human-readable `detail`. Programs match on the code; people read the detail.

### 3.2 Scoring

For the eligible set:

- **cost** is min-max normalized within the set (cheapest 1, dearest 0, all-equal 1);
- **quality** is `(tier - 1) / 4` on a fixed scale;
- **latency** is `fast` 1, `standard` 0.5, `slow` 0 on a fixed scale;
- the final score is `(wc*cost + wq*quality + wl*latency) / (wc + wq + wl)`, rounded to six decimals.

The asymmetry is intentional. Cost has no natural bounds (prices span orders of magnitude), so it can only be judged relative to what else is on the table. Quality and latency have natural scales, and normalizing them within the set would make a lone mediocre candidate look perfect and would let an unrelated candidate's elimination change another's score.

Min-max normalization of cost is linear, which means a very expensive outlier compresses the differences between all cheaper models toward 1. That is a real weakness: with a 100x price outlier in the eligible set, the cost term barely distinguishes the cheap models, so quality and latency dominate among them. A log-scale cost score would fix it at the price of being harder to reason about by hand. This implementation chooses legibility.

### 3.3 Determinism

Sources of nondeterminism that were removed on purpose:

- **iteration order**: candidates are evaluated in `provider/model` string order regardless of catalog order (tested by reversing the catalog);
- **floating point noise**: costs are rounded to nine decimals and scores to six, so equal-looking values compare equal and serialize identically;
- **locale**: string comparison uses `<` and `>`, never `localeCompare`;
- **ties**: broken by score, then lower estimated cost, then higher quality tier, then route id. The last key makes the order total.

What is not deterministic by design: nothing in the router. The gateway adds real time only through an injected clock, and timeouts through real timers.

### 3.4 Fallback chain

After ranking (and after the budget gate), the chain is the next `fallbackDepth` ranked routes. With `distinctProviderFallbacks` the chain skips routes whose provider is already present: a second model from a provider that is down is not a fallback. The chain length is configurable per task class, because a classification call can reasonably give up sooner than a code review.

## 4. Budgets

Budgets are per tenant over fixed windows aligned to the epoch (`[k*W, (k+1)*W)`). Fixed windows are simple and predictable but allow a burst at a boundary (a tenant can spend a full limit at the end of one window and again at the start of the next). A sliding window or token bucket would smooth that and is a natural extension.

The gate is applied *after* ranking. Every ranked route whose estimate exceeds the remaining budget is excluded from the primary slot **and from the fallback chain**; otherwise a fallback served after a primary failure could overshoot the window. Each exclusion is recorded in `decision.budget.excluded` with the route, its estimate and the code `EXCEEDS_REMAINING_BUDGET`. The outcome then depends on the best-ranked route's estimate:

- fits: proceed;
- over and `onExceed: "reject"`: status `rejected`, reason `BUDGET_EXCEEDED`;
- over and `onExceed: "downgrade"`: drop routes whose estimate exceeds what remains, take the best of the rest; if none is affordable, reject.

A downgrade chooses the highest-*scoring* affordable route, not the cheapest, so the tenant gets the best service its remaining budget can buy. The decision records `downgradedFrom` and the excluded routes.

Spend is charged from *actual* usage after a successful call; the estimate is used only for the gate. Two consequences: concurrent in-flight requests do not see each other's pending cost, so a window can be overshot; and failed calls cost nothing. Reserving estimated cost up front and reconciling afterwards would fix the first at the price of more state.

## 5. Execution, retries and the breaker

The gateway walks `[primary, ...fallbacks]`:

- success: stop;
- retryable error or timeout: record, count a failure against the provider's breaker, continue;
- non-retryable error: record, stop. The request is at fault; another model would fail the same way or mask a bug. The provider did respond, so the breaker is credited with a success (this also releases a half-open probe slot);
- unclassified exception (anything that is not a `ProviderError`): treated as a retryable provider failure, recorded with code `UNKNOWN`, and counted against the breaker. A plain `Error` from an adapter is most often a transport fault (reset connection, DNS), so falling back is the useful behavior, and `fallbackDepth` bounds the cost of being wrong. An adapter that wants to stop the walk must say so with `ProviderError(code, message, false)`. An earlier version failed closed here and credited the breaker with a success, which let a dead provider keep its breaker closed forever.

There is no retry of the *same* route. Within-route retries and hedged requests interact with timeouts and idempotency in ways that are better decided per adapter.

### 5.1 Breaker semantics

```
closed --(N consecutive failures)--> open --(cool-down)--> half-open
half-open --(probe ok)--> closed
half-open --(probe fails)--> open (cool-down restarts)
```

- The count is of *consecutive* failures; any success resets it. A rate-over-window breaker handles flaky-but-working providers better and is the usual production refinement.
- State is evaluated lazily from the clock: reading `state` on an open breaker whose cool-down has elapsed promotes it to half-open. There are no timers, which is what makes the injectable clock sufficient for deterministic tests.
- Half-open admits `halfOpenMaxProbes` requests. `allowRequest()` consumes a slot; success or failure releases it. If the slot is taken, the route is recorded as an attempt with `skipReason: "CIRCUIT_OPEN"` and the walk continues.
- Two places record breaker effects, for different reasons. At *routing* time, open providers are eliminated with `CIRCUIT_OPEN` so the primary and the fallback chain are built only from providers that can be tried. At *execution* time, a skip can still happen (half-open with no free probe slot, or a breaker that opened between routing and attempting), and it is recorded on the attempt. Half-open providers are not excluded at routing time, because the probe has to come from somewhere.

Tuning guidance: choose the threshold and cool-down from the cost of a failed attempt (latency until timeout, plus the work wasted on the fallback) against the cost of shedding a provider that has recovered. Short cool-downs with a single probe recover fast and expose one request to a still-broken provider per cycle. These are policy values in JSON precisely so they can be changed and reviewed.

## 6. The decision log

One JSON object per line: `{ schemaVersion, timestamp, request, decision, outcome }`. JSONL because it is append-friendly, streamable, and grep-able. A crash mid-append can leave a truncated final line; earlier lines remain intact, but the reader does **not** skip a bad line: it fails the whole read with an error naming the line number (and, for a shape problem, the field path), and the replay CLI exits with code 2. Every record is validated completely on read (decision candidates, eliminations, ranking, budget block and outcome attempts, plus the cross-check that a routed decision's primary appears in its ranking), so replay never meets a malformed shape. Repairing a truncated tail is left to the operator.

The decision is stored in full (all candidates and eliminations), which is verbose: the bundled 32-record log is about 100 KB. A production system would likely store the decision compactly and re-derive the explanation from the stored policy and catalog versions on demand, which this design supports (because routing is pure) but does not implement.

The log is append-only by convention: nothing in the library rewrites or deletes records. Concurrent writers from multiple processes are not coordinated.

## 7. Replay

`replay(records, candidatePolicy, candidateCatalog)` re-routes each recorded request and compares the candidate decision to the recorded one. It imports the router and the budget arithmetic only. It cannot execute anything because it has no access to adapters, breakers or the gateway.

Design decisions:

- **Baseline is the recording, not a re-run.** The comparison is "what happened" versus "what would happen". Replaying the recorded policy against the recorded log produces zero changes, which a test asserts; that is a determinism check on the whole pipeline, including budgets.
- **Breaker state is replayed from the record.** Each record's `decision.context.openProviders` is passed to the candidate. Otherwise every request that overlapped an outage would show up as a spurious diff, or a real fragility (a policy with no redundant provider) would be masked. Using the recorded state attributes differences to the policy.
- **Budgets are re-simulated** from log timestamps with a fresh tracker, because the candidate may make different spend decisions. Only requests that originally succeeded are charged. If the candidate keeps the same primary the recorded actual cost is charged (so fallbacks that really happened are preserved); otherwise the candidate's estimate is charged. This is an approximation and is labeled as such.
- **Cost delta covers comparable requests only.** A request that became unroutable would otherwise look like a cost saving. Newly unroutable and newly routable requests are counted separately. With a zero baseline the percentage is undefined: it is reported as `null` (`n/a, zero baseline` in text) when the cost rose, and `--max-cost-increase-pct` then fails; the absolute-dollar limit is the tool for that case.
- **Known limits of the comparison.** Only the primary route is compared, so a candidate that changes fallback chains but not primaries shows no diff. Budget rejections are counted in the same bucket as unroutable requests (the entry carries the reason code). Per-class `unchanged` excludes requests unroutable on both sides, matching the totals; those appear as `stillUnroutable`.
- **Thresholds are explicit and optional**: newly unroutable count (default 0 in the CLI), changed-primary percentage, cost increase in percent and in dollars. A violated threshold sets a non-zero exit code. Thresholds are configuration of the *gate*, not of the policy.

What replay proves and does not: see the README. In short, it proves routing consequences given recorded descriptors, and says nothing about response quality, real latency, real availability, or demand response.

## 8. Validation

Validators are written without a schema library to keep the dependency count at zero and to control messages. Principles:

- collect all problems, never just the first, each with a JSON-path-like location;
- reject unknown keys, because a misspelled optional field otherwise silently does nothing;
- check cross-references when a catalog is available (a deny rule naming a provider that does not exist is almost certainly a typo);
- return fresh, normalized objects (defaults applied) rather than the raw input.

The cost of custom validation is repetition; the benefit is that error text is exactly as clear as it is made to be.

## 9. Testing strategy

- The router is tested as a pure function: one assertion group per elimination code, scoring arithmetic on hand-checkable inputs, tie-break order, catalog-order independence, structural determinism.
- Time-dependent components (breaker, budgets, gateway) take an injected `ManualClock`; the only real-time element is the timeout test, which uses a 25 ms timeout against a mock that never answers.
- The bundled sample log is produced by the real gateway (`npm run generate:log`) and regenerating it is byte-for-byte reproducible. Tests assert that it contains the interesting cases (breaker-open records, downgrades, a rejection, an unroutable request, a timeout, a served fallback, a non-retryable failure).
- CLI entry points are plain functions taking argv and an output sink, so they are tested without spawning processes.

## 10. Extension points

- **Adapters**: implement `ProviderAdapter`; the gateway needs only `provider` and `invoke(call, signal)`. Map provider-specific errors to `ProviderError` with the right `retryable` flag; that mapping is the main piece of real-world work.
- **Shared state**: `BreakerRegistry` and `BudgetTracker` are small classes over in-memory maps; replacing them with a shared store is mechanical, but then races (two processes tripping or probing simultaneously) need a deliberate answer.
- **Scoring**: `rank` is one function; a log-scale cost term or additional dimensions would be local changes, and replay would show their effect on a log.
