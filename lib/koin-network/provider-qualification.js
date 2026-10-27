"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const P = require("./job-protocol"), { uint, DAY } = require("./policy"), Q = require("./qualification-protocol");
const Evidence = require("./qualification-evidence");
function policy(value, tariff) {
  if (!value || Object.keys(value).sort().join() !== "cases,coverageBps,maxLatencyMs,minPass,model,modelHash,modelWeight,renewBeforeMs,retryMs,reviewedEvidenceHash,schema" || value.schema !== 1) throw Error("Reviewed qualification policy required");
  const p = structuredClone(value);
  if (!tariff || p.model !== tariff.model || p.modelHash !== tariff.modelHash) throw Error("Qualification model pin mismatch");
  P.digest(p.reviewedEvidenceHash); if (!uint(p.modelWeight)) throw Error("Reviewed model weight required");
  P.integer(p.coverageBps, 7500, 15000); P.integer(p.renewBeforeMs, 60000, DAY - 60000); P.integer(p.retryMs, 60000, DAY);
  P.integer(p.maxLatencyMs, 1, Math.min(180000, tariff.maxLatencyMs));
  if (!Array.isArray(p.cases) || !p.cases.length || p.cases.length > 32) throw Error("Bounded reviewed benchmark cases required");
  P.integer(p.minPass, 1, p.cases.length); const ids = new Set();
  for (const c of p.cases) {
    if (!c || Object.keys(c).sort().join() !== "expected,id,maxOutput,messages" || typeof c.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) || ids.has(c.id)) throw Error("Unique benchmark cases required");
    ids.add(c.id); c.messages = P.messages(c.messages); P.integer(c.maxOutput, 1, tariff.maxOutputTokens);
    if (!Array.isArray(c.expected) || !c.expected.length || c.expected.length > 8 || c.expected.some(s => typeof s !== "string" || !s.trim() || s !== s.trim() || Buffer.byteLength(s) > 65536)) throw Error("Explicit unambiguous accepted benchmark answers required");
  }
  return p;
}
class ProviderQualification {
  constructor({ file, policy: value, target, meter, clock = Date.now, reviewed = () => [], modelCapacity = false, providerDevices, preparePresence }) {
    Object.assign(this, { file, target, meter, clock, reviewed, modelCapacity, providerDevices, preparePresence });
    this.tariff = meter.tariffs().find(t => t.model === value?.model && t.modelHash === value?.modelHash);
    this.policy = policy(value, this.tariff); this.policyHash = P.hash(JSON.stringify(this.policy));
    this.targetHash = P.hash(JSON.stringify(target));
    this.state = { schema: 1, clock: 0, runs: {}, records: {} };
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 4000000 || fs.lstatSync(file).isSymbolicLink()) throw Error("Invalid qualification recovery file");
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved.hash !== P.hash(JSON.stringify(saved.state)) || saved.state?.schema !== 1 || !saved.state.runs || !saved.state.records) throw Error("Damaged qualification recovery file");
      this.state = saved.state;
    }
  }
  now() { const now = P.integer(this.clock()); if (now < this.state.clock) throw Error("Qualification clock moved backwards"); return now; }
  save() {
    this.state.clock = this.now(); const text = JSON.stringify({ state: this.state, hash: P.hash(JSON.stringify(this.state)) });
    if (Buffer.byteLength(text) > 4000000) throw Error("Qualification evidence capacity reached");
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + ".tmp", fd = fs.openSync(temp, "w", 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temp, this.file);
  }
  targetMatches(run) {
    if (!run) return false;
    if (run.targetHash !== undefined) return run.targetHash === this.targetHash;
    // Old files are retained. Only evidence with an identifiable matching target
    // may resume; unknown old benchmark state never establishes fresh admission.
    const targets = [run.pending?.target, ...run.results.map(r => r.signedMaterial?.target)].filter(Boolean);
    return targets.length > 0 && targets.every(t => P.hash(JSON.stringify(t)) === this.targetHash);
  }
  records() { const now = this.now(); return Object.values(this.state.records).filter(r => r.policyHash === this.policyHash &&
    P.hash(JSON.stringify(r.evidence?.target ?? null)) === this.targetHash && r.qualification.expires > now).map(r => ({ ...structuredClone(r.qualification), fingerprint: r.evidence.fingerprint })); }
  fingerprintOwnedElsewhere(worker) {
    return [...this.reviewed(), ...this.records()].some(q => q.address !== worker.address &&
      (q.fingerprint === worker.fingerprint || q.capacityId?.endsWith(worker.fingerprint)));
  }
  status(address) {
    const run = this.state.runs[address]; if (!run || run.policyHash !== this.policyHash || !this.targetMatches(run)) return null;
    return { state: run.state, ...(run.providerDeviceId ? { deviceId: run.providerDeviceId } : {}), passed: run.results.filter(r => r.passed).length, completed: run.results.length, total: this.policy.cases.length, retryAt: run.retryAt || null };
  }
  busy(address) { const run = this.state.runs[address]; return run?.policyHash === this.policyHash && this.targetMatches(run) && run.state === "testing" && !!run.pending && run.pending.challenge.deadline > this.now(); }
  finish(run) {
    run.state = run.results.filter(r => r.passed).length >= this.policy.minPass ? "qualified" : "failed"; run.pending = null; run.retryAt = this.now() + this.policy.retryMs;
    if (run.state === "qualified") {
      const evidence = { policyHash: this.policyHash, target: structuredClone(this.target), address: run.address, fingerprint: run.fingerprint, results: run.results };
      const qualification = { address: run.address, ...(run.providerAuthorization ? { providerAuthorization: run.providerAuthorization, providerDeviceId: run.providerDeviceId } : {}), capacityId: run.capacityId, model: this.policy.model, modelHash: this.policy.modelHash,
        benchmarkHash: P.hash(JSON.stringify(evidence)), modelWeight: this.policy.modelWeight, coverageBps: this.policy.coverageBps, expires: this.now() + DAY };
      const directory = path.join(path.dirname(this.file), "qualification-evidence"), file = path.join(directory, qualification.benchmarkHash + ".json");
      const archive = JSON.stringify({ schema: 1, policy: this.policy, evidence, qualification });
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.existsSync(file)) { if (fs.readFileSync(file, "utf8") !== archive) throw Error("Qualification evidence changed"); }
      else { const fd = fs.openSync(file, "wx", 0o600); try { fs.writeFileSync(fd, archive); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      this.state.records[run.recordId || run.capacityId] = { policyHash: this.policyHash, qualification, evidence };
    }
  }
  next(worker) {
    const now = this.now(), address = worker.address;
    if (worker.providerAuthorization && !this.providerDevices?.workerActive(worker)) return null;
    if (worker.proof !== "signed" || worker.capabilities?.koinQualification !== 1 || !worker.models?.includes(this.policy.model) || !/^[a-f0-9]{16}$/.test(worker.fingerprint || "")) return null;
    const all = [...this.reviewed(), ...this.records()], previous = all.filter(q => q.address === address && q.model === this.policy.model && q.modelHash === this.policy.modelHash && (!worker.providerDeviceId || q.providerDeviceId === worker.providerDeviceId)).sort((a, b) => b.expires - a.expires)[0];
    if (this.fingerprintOwnedElsewhere(worker)) return null;
    if (previous?.expires > now + this.policy.renewBeforeMs && (previous.fingerprint === worker.fingerprint || previous.capacityId.endsWith(worker.fingerprint))) return null;
    let run = this.state.runs[address];
    if (this.targetMatches(run) && run?.state === "testing" && worker.providerAuthorization && run.providerAuthorization && this.providerDevices?.workerActive(run) &&
        run.providerAuthorization !== worker.providerAuthorization && Math.max(run.pending?.challenge.deadline || 0, run.preparation?.expiresAt || 0) > now) return null;
    if (this.targetMatches(run) && run?.state === "testing" && run.fingerprint !== worker.fingerprint) {
      // A second authorized device cannot cancel the first device's live
      // benchmark. One reward wallet still has one effective concurrent slot.
      if (worker.providerAuthorization && this.providerDevices?.workerActive(run) && run.providerDeviceId !== worker.providerDeviceId && Math.max(run.pending?.challenge.deadline || 0, run.preparation?.expiresAt || 0) > now) return null;
      run.state = "failed"; run.pending = null; run.retryAt = now + this.policy.retryMs; this.save(); return null;
    }
    if (run?.state === "testing" && run.policyHash === this.policyHash && this.targetMatches(run) && run.fingerprint === worker.fingerprint &&
        (!worker.providerAuthorization || run.providerAuthorization === worker.providerAuthorization)) {
      if (run.pending?.challenge.deadline > now) return null;
      if (run.pending) { run.results.push({ id: run.pending.challenge.id, caseId: this.policy.cases[run.order[run.results.length]].id, passed: false, reason: "deadline", at: now }); run.pending = null; }
      if (run.results.length === this.policy.cases.length) { this.finish(run); this.save(); return null; }
    } else {
      if (run?.policyHash === this.policyHash && this.targetMatches(run) && run?.retryAt > now && (!worker.providerAuthorization || run.providerAuthorization === worker.providerAuthorization)) return null;
      if (!run && Object.keys(this.state.runs).length >= 256) return null;
      const order = this.policy.cases.map((_, i) => i); for (let i = order.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
      run = this.state.runs[address] = { address, fingerprint: worker.fingerprint, ...(worker.providerAuthorization ? { providerAuthorization: worker.providerAuthorization, providerDeviceId: worker.providerDeviceId } : {}), recordId: worker.providerAuthorization ? worker.providerAuthorization : undefined, capacityId: worker.providerAuthorization ? "wallet-" + P.hash(this.policy.model + ":" + this.policy.modelHash + ":" + address) : this.modelCapacity ? "device-" + P.hash(this.policy.model + ":" + this.policy.modelHash).slice(0, 16) + "-" + worker.fingerprint : (previous?.fingerprint === worker.fingerprint ? previous.capacityId : null) || "device-" + worker.fingerprint, policyHash: this.policyHash, targetHash: this.targetHash, state: "testing", order, results: [], pending: null };
    }
    // Model loading is a separate bounded preparation step. Only an accepted
    // fresh signed report from this same device can start the unchanged timed
    // answer challenge. Never turn a prepared model into a qualification.
    if (worker.providerAuthorization && worker.capabilities?.koinModelOnDemand === 1 && typeof this.preparePresence === "function") {
      const presence = this.preparePresence(worker), prepared = run.preparation;
      if (prepared && now >= prepared.expiresAt) {
        run.state = "failed"; run.pending = null; run.preparation = null; run.retryAt = now + this.policy.retryMs;
        this.save(); return null;
      }
      const ready = presence?.ready === true && Number.isSafeInteger(presence.at) && presence.at <= now && presence.at > now - 90000 &&
        presence.model === this.policy.model && presence.modelHash === this.policy.modelHash && (!prepared || presence.at >= prepared.issuedAt);
      if (!ready) {
        if (!prepared) { run.preparation = { issuedAt: now, expiresAt: now + 120000 }; this.save(); }
        return { type: "koin-provider-prepare", target: structuredClone(this.target), policyHash: this.policyHash,
          model: this.policy.model, modelHash: this.policy.modelHash, ...run.preparation };
      }
      if (prepared) { run.preparation = null; this.save(); }
    }
    const c = this.policy.cases[run.order[run.results.length]], tariff = this.tariff;
    const quote = this.meter.quote(this.target.domain, this.policy.model, tariff.version, c.messages, c.maxOutput, now), prompt = this.meter.entry(this.policy.model, tariff.version).render(c.messages, quote.at);
    run.pending = { type: "koin-provider-qualification", target: this.target, policyHash: this.policyHash, challenge: { type: "koin-shadow-chat", id: crypto.randomBytes(32).toString("hex"), attempt: crypto.randomBytes(32).toString("hex"), model: this.policy.model, quote, prompt, dispatchedAt: now, deadline: now + this.policy.maxLatencyMs } };
    this.save(); return structuredClone(run.pending);
  }
  result(worker, body) {
    const now = this.now(), run = this.state.runs[worker.address];
    if (run?.providerAuthorization && (!this.providerDevices?.workerActive(worker) || worker.providerAuthorization !== run.providerAuthorization || worker.providerDeviceId !== run.providerDeviceId)) throw Error("Qualification belongs to another authorized device");
    if (!body || Object.keys(body).sort().join() !== "jobId,output,signature" || typeof body.output !== "string" || !body.output.trim() || Buffer.byteLength(body.output) > 65536) throw Error("Bounded qualification answer required");
    const outputHash = P.hash(body.output), prior = run?.results.find(r => r.id === body.jobId);
    if (worker.proof === "signed" && this.targetMatches(run) && run.policyHash === this.policyHash && !this.fingerprintOwnedElsewhere(worker) && run?.fingerprint === worker.fingerprint && prior?.outputHash === outputHash && prior.signature === body.signature) return { accepted: true, qualification: this.status(worker.address) };
    const job = run?.pending;
    if (worker.proof !== "signed" || !job || !this.targetMatches(run) || this.fingerprintOwnedElsewhere(worker) || run.policyHash !== this.policyHash || job.challenge.id !== P.digest(body.jobId) || job.challenge.deadline <= now || run.fingerprint !== worker.fingerprint) throw Error("Qualification attempt expired or changed");
    if (run.providerAuthorization) this.providerDevices.verify(body.signature, "qualification", Q.resultHash(job, outputHash), worker.address, run);
    else P.signatureMatches(Q.resultHash(job, outputHash), body.signature, worker.address);
    const c = this.policy.cases[run.order[run.results.length]];
    this.meter.measure(job.challenge.quote, body.output);
    run.results.push({ id: body.jobId, caseId: c.id, passed: c.expected.includes(body.output.trim()), outputHash, signature: body.signature,
      signedMaterial: Evidence.signedMaterial(job), at: now, latencyMs: now - job.challenge.dispatchedAt }); run.pending = null;
    if (run.results.length === this.policy.cases.length) this.finish(run);
    this.save(); return { accepted: true, qualification: this.status(worker.address) };
  }
}
module.exports = { ProviderQualification, policy };
