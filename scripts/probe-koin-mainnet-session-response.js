"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { setup, sign } = require("./helpers/koin-delegation-fixture");
const D = require("../lib/koin-network/session-delegation");
const P = require("../lib/koin-network/job-protocol");

// Exercise the real HTTP router and chain observer together. The observer's
// read-only evidence flag must not overwrite the pinned mainnet wire mode.
for (const mainnet of [true, false]) {
  const mode = mainnet ? "mainnet-pilot" : "funded-rehearsal";
  const wire = (result, ok = true) => {
    assert.equal(result.mode, mode);
    assert.equal(result.paymentsEnabled, mainnet);
    assert.equal(result.ok, ok);
  };
  test(`${mode} session responses retain their network identity through approval and revocation`, async t => {
    const f = await setup(t, { mainnet, finalizeObservation: false });
    assert.equal(f.observation.status, 200); wire(f.observation.body);
    assert.equal(f.observation.body.state, "observed");
    assert.equal(f.observation.body.spendingAuthorized, false);
    const evidence = await f.observer.verify(f.observationId);
    assert.equal(evidence.state, "reversible");
    assert.equal(evidence.paymentsEnabled, false);
    assert.equal(evidence.spendingAuthorized, false);
    const pending = await f.review(); wire(pending);
    assert.equal(pending.state, "reversible");
    assert.equal(pending.terms, undefined);

    f.finalize();
    const verified = await f.observer.verify(f.observationId);
    assert.equal(verified.state, "verified");
    assert.equal(verified.paymentsEnabled, false);
    assert.equal(verified.spendingAuthorized, false);
    const review = await f.review(); wire(review);
    assert.equal(review.terms.mode, mode);
    assert.equal(review.terms.target.chainId, f.target.chainId);
    assert.equal(review.terms.session, f.id);
    assert.equal(review.terms.amount, f.proposal.amount);
    assert.equal(D.id(review.terms), review.delegationId);

    const approval = await f.authorize(review); wire(approval.status);
    assert.equal(approval.status.state, "active");
    assert.equal(approval.status.spent, "0");
    assert.equal(approval.status.held, "0");
    assert.equal(approval.status.available, f.proposal.amount);
    const status = await f.post("status", { id: approval.delegationId });
    assert.equal(status.status, 200); wire(status.body);
    assert.equal(status.body.state, "active");
    const request = await f.post("request-status", { id: approval.delegationId, requestId: P.hash("unsubmitted-session-request") });
    assert.equal(request.status, 200); wire(request.body);
    assert.equal(request.body.state, "unknown");
    assert.equal(request.body.amount, "0");
    const revoked = await f.post("revoke", { id: approval.delegationId });
    assert.equal(revoked.status, 200); wire(revoked.body);
    assert.equal(revoked.body.state, "revoked");
    const replay = await f.post("authorize", approval.request);
    assert.equal(replay.status, 200); wire(replay.body);
    assert.equal(replay.body.state, "revoked");
  });
  test(`${mode} authentication and changed funding fail without changing response identity`, async t => {
    const f = await setup(t, { mainnet });
    const denied = await f.post("observe", { grantId: f.grant.id, session: f.id }, "invalid-fixture-token");
    assert.equal(denied.status, 401); wire(denied.body, false);
    assert.equal(denied.body.observationId, undefined);
    const review = await f.review();
    const signature = await sign(D.hash(review.terms));
    f.session.session.owner = f.session.session.verifier;
    const rejected = await f.post("authorize", { grantId: f.grant.id, observationId: f.observationId, terms: review.terms, signature });
    assert.equal(rejected.status, 400); wire(rejected.body, false);
    assert.match(rejected.body.error, /Session identity or policy mismatch/);
    assert.throws(() => f.ledger.delegationStatus({ id: review.delegationId, accountId: f.account.id }), /unavailable/);
  });
}
