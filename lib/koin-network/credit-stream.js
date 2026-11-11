"use strict";
const version = 1, header = "x-kai-credit-stream", capability = "keepalive-v1", intervalMs = 15000;

// Older desktop readers accept data frames only. Send comments only after the
// caller opts in; a keep-alive carries no answer, receipt, usage or charge.
function keepalive(req, res, everyMs = intervalMs) {
  if (req.headers?.[header] !== capability) return () => {};
  let timer;
  const stop = () => { clearInterval(timer); res.removeListener("close", stop); res.removeListener("finish", stop); };
  const send = () => {
    if (res.destroyed || res.writableEnded) return stop();
    if (res.writableLength > 2000000) { stop(); res.destroy(); return; }
    try { res.write(": kai-keepalive\n\n"); }
    catch { stop(); res.destroy(); }
  };
  res.on("close", stop); res.on("finish", stop);
  send();
  if (!res.destroyed && !res.writableEnded) { timer = setInterval(send, everyMs); timer.unref?.(); }
  return stop;
}
module.exports = { version, header, capability, intervalMs, keepalive };
