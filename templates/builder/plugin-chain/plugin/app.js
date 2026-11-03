"use strict";
const $ = id => document.getElementById(id), ui = window.PluginText;
let working = false;
const busy = value => { working = value; for (const id of ["configure", "refresh", "address"]) $(id).disabled = value; };
async function run(task) {
  if (working) return;
  busy(true);
  try { await task(); } catch (error) { ui.error(error); } finally { busy(false); }
}
$("configure").onclick = () => run(async () => {
  const config = await window.kai.call("counter.configure", { address: $("address").value.trim() });
  $("address").value = config.address;
  $("count").textContent = "—"; $("observed").textContent = "";
  ui.status("addressSaved");
});
$("refresh").onclick = () => run(async () => {
  ui.status("reading");
  const result = await window.kai.call("counter.read", {});
  $("count").textContent = String(result.count);
  $("observed").textContent = result.address + " · " + new Date(result.observedAt).toLocaleString(document.documentElement.lang);
  ui.status("read");
});
void (async () => {
  await ui.start();
  if (!window.kai?.call) { busy(true); ui.status("notCore"); return; }
  await run(async () => {
    const config = await window.kai.call("counter.config", {});
    $("address").value = config.address;
    $("network").textContent = config.network + " · " + config.rpc;
    ui.status("ready");
  });
})();
