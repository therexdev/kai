"use strict";

const fs = require("fs");
const path = require("path");

/*
 * Restart forensics. koinosai.com runs the scheduler in one Node process on
 * one host; when it disappears and comes back we need to know WHY — a host
 * recycle (SIGTERM) vs a code crash (uncaughtException) are very different
 * problems, and guessing is exactly what the field rules forbid.
 *
 * On boot this reads a persisted runtime.json, bumps a boot counter, and
 * records the PREVIOUS exit's cause (captured by the signal/exception
 * handlers below before the process died). The public-safe summary
 * (bootCount, last exit reason + time, NO stack) is surfaced on /api/health;
 * the full stack persists to disk for the operator export. So the next
 * restart reports its own cause instead of leaving a mystery.
 */

function startRuntimeLog(dataDir, log = () => {}) {
  const file = path.join(dataDir, "runtime.json");
  let state = { bootCount: 0, lastExit: null, history: [] };
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* first boot */
  }
  state.bootCount = (state.bootCount || 0) + 1;
  state.bootAt = new Date().toISOString();
  if (state.lastExit) {
    log(`previous exit: ${state.lastExit.reason} at ${state.lastExit.at}${state.lastExit.message ? " — " + state.lastExit.message : ""}`);
  }
  const save = () => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2));
    } catch {
      /* best-effort — never let logging crash the process */
    }
  };
  save();

  let recorded = false;
  const record = (reason, err) => {
    if (recorded) return; // one exit, one record
    recorded = true;
    const exit = {
      at: new Date().toISOString(),
      reason,
      message: err ? String(err && err.message ? err.message : err).slice(0, 300) : undefined,
      stack: err && err.stack ? String(err.stack).slice(0, 4000) : undefined,
    };
    state.lastExit = exit;
    state.history = [exit, ...(state.history || [])].slice(0, 10); // keep the last 10
    save();
  };

  // Host recycle / graceful shutdown.
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      record(`signal:${sig}`);
      process.exit(0);
    });
  }
  // A real code crash. Persist the stack, then exit so the host restarts a
  // clean process — swallowing an uncaught exception can leave corrupt
  // in-memory state, which is worse than a fast restart.
  process.on("uncaughtException", (err) => {
    record("uncaughtException", err);
    log(`FATAL uncaughtException: ${err && err.message}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    record("unhandledRejection", err);
    log(`FATAL unhandledRejection: ${err && (err.message || err)}`);
    process.exit(1);
  });

  // Public-safe summary for /api/health and status (no stack).
  return {
    summary() {
      return {
        bootCount: state.bootCount,
        bootAt: state.bootAt,
        lastExit: state.lastExit
          ? { reason: state.lastExit.reason, at: state.lastExit.at }
          : null,
      };
    },
  };
}

module.exports = { startRuntimeLog };
