"use strict";
const $ = id => document.getElementById(id), ui = window.PluginText;
let working = false, noteRevision = 0;
const busy = value => { working = value; for (const id of ["save", "models", "improve"]) $(id).disabled = value; };
$("note").addEventListener("input", () => { noteRevision++; });
async function run(task) {
  if (working) return;
  busy(true);
  try { await task(); } catch (error) { ui.error(error); } finally { busy(false); }
}
async function models() {
  const selected = $("model").value;
  const list = await window.kai.call("models.list", {});
  $("model").replaceChildren();
  for (const model of list.filter(m => m.status === "ready" && !/^koinos-network(?::|$)/.test(m.alias))) {
    const option = document.createElement("option"); option.value = model.alias; option.textContent = model.label || model.alias; $("model").append(option);
  }
  if ([...$("model").options].some(o => o.value === selected)) $("model").value = selected;
  ui.status($("model").options.length ? "ready" : "noModels");
}
$("save").onclick = () => run(async () => { await window.kai.call("storage.set", { key: "note", value: $("note").value }); ui.status("saved"); });
$("models").onclick = () => run(models);
$("improve").onclick = () => run(async () => {
  if (!$("model").value) { ui.status("select"); return; }
  ui.status("generating");
  const { text } = await window.kai.call("inference.local", {
    model: $("model").value, maxTokens: 600,
    prompt: "Develop this idea into a concise, practical draft. Use the same language as the idea. Do not claim to have performed actions.\n\n" + $("note").value,
  });
  $("draft").textContent = text;
  $("suggestion").hidden = false;
  ui.status("ready");
});
$("apply").onclick = () => { $("note").value = $("draft").textContent; noteRevision++; ui.status("applied"); };
void (async () => {
  await ui.start();
  if (!window.kai?.call) { busy(true); ui.status("notCore"); return; }
  await run(async () => {
    const before = noteRevision, note = await window.kai.call("storage.get", { key: "note" });
    if (before === noteRevision && typeof note === "string") $("note").value = note;
    await models();
  });
})();
