"use strict";
// Native metadata is committed inside the existing quoted message payload. It is
// removed from messages and sent as real API tools, never rendered as prompt text.
const names = /^[A-Za-z0-9_-]{1,64}$/, ids = /^[A-Za-z0-9_-]{1,200}$/;
function object(v) { return v && typeof v === "object" && !Array.isArray(v); }
function keys(v, allowed) { if (!object(v) || Object.keys(v).some(k => !allowed.includes(k))) throw Error("Invalid native tool fields"); }
function bounded(v, max) { if (Buffer.byteLength(JSON.stringify(v)) > max) throw Error("Native tool payload too large"); return v; }
function tools(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw Error("Invalid native tools");
  const seen = new Set();
  return bounded(value.map(t => {
    keys(t,["type","function"]); keys(t.function,["name","description","parameters"]);
    const f=t.function;
    if(t.type!=="function" || !names.test(f.name) || seen.has(f.name) || typeof f.description!=="string" || f.description.length>1500 || !object(f.parameters) || f.parameters.type!=="object") throw Error("Invalid function schema");
    seen.add(f.name); return { type:"function", function:{ name:f.name, description:f.description, parameters:structuredClone(f.parameters) } };
  }), 32768);
}
function calls(value) {
  if(!Array.isArray(value) || !value.length || value.length>8) throw Error("Invalid tool calls");
  const seen=new Set();
  return value.map(c => {
    keys(c,["id","type","function"]); keys(c.function,["name","arguments"]);
    if(c.type!=="function" || !ids.test(c.id) || seen.has(c.id) || !names.test(c.function.name) || typeof c.function.arguments!=="string" || Buffer.byteLength(c.function.arguments)>16000) throw Error("Invalid tool call");
    seen.add(c.id); return { id:c.id, type:"function", function:{ name:c.function.name, arguments:c.function.arguments } };
  });
}
function messages(value) {
  if(!Array.isArray(value) || !value.length || value.length>256) throw Error("Invalid messages");
  const pending=new Set(), used=new Set();
  const clean=value.map((m,i) => {
    keys(m,["role","content","tool_calls","tool_call_id","kai_tools"]);
    if(!["system","user","assistant","tool"].includes(m.role) || !(typeof m.content==="string" || (m.role==="assistant" && m.content===null))) throw Error("Invalid native message");
    const out={role:m.role,content:m.content || ""};
    if(m.role==="tool") {
      if(!pending.delete(m.tool_call_id) || m.tool_calls || m.kai_tools) throw Error("Orphan or repeated tool result");
      out.tool_call_id=m.tool_call_id;
    } else {
      if(pending.size || m.tool_call_id!==undefined) throw Error("Missing tool results");
      if(m.tool_calls!==undefined) {
        if(m.role!=="assistant") throw Error("Only assistants call tools");
        out.tool_calls=calls(m.tool_calls);
        for(const c of out.tool_calls) { if(used.has(c.id)) throw Error("Repeated tool call ID"); used.add(c.id); pending.add(c.id); }
      }
      if(m.kai_tools!==undefined) {
        if(i!==0 || m.role!=="system") throw Error("Invalid tool registry position");
        out.kai_tools=tools(m.kai_tools);
      }
    }
    return out;
  });
  if(pending.size) throw Error("Missing tool results");
  return bounded(clean,65536);
}
function isNative(value) { return Array.isArray(value) && value.some(m => m?.kai_tools || m?.tool_calls || m?.role==="tool"); }
function enabled(model, env=process.env) { return String(env.KAI_NATIVE_TOOL_MODELS || "").split(",").map(v=>v.trim()).includes(model); }
function encode(history, definitions) {
  if(history.some(m=>m?.kai_tools!==undefined)) throw Error("Internal tool metadata is not an API field");
  const result=structuredClone(history);
  if(result[0]?.role!=="system") result.unshift({role:"system",content:""});
  result[0].kai_tools=tools(definitions);
  return messages(result);
}
function upstream(value) {
  const clean=messages(value), definitions=clean[0]?.kai_tools;
  if(!definitions) throw Error("Native request has no tool registry");
  return { messages:clean.map(({kai_tools,...m})=>m), tools:definitions, tool_choice:"auto", parallel_tool_calls:false };
}
function packAnswer(message, finishReason) {
  keys(message,["role","content","tool_calls","refusal","annotations","reasoning","reasoning_content"]);
  if(message.role!=="assistant" || !["stop","length","tool_calls"].includes(finishReason)) throw Error("Invalid native answer");
  const content=message.content ?? "";
  if(typeof content!=="string" || (!content.trim() && !message.tool_calls?.length)) throw Error("Empty native answer");
  const toolCalls=message.tool_calls?.length ? calls(message.tool_calls) : [];
  if((finishReason==="tool_calls")!==Boolean(toolCalls.length)) throw Error("Inconsistent native finish reason");
  return JSON.stringify({ schema:1, message:{role:"assistant",content,...(toolCalls.length?{tool_calls:toolCalls}:{})}, finishReason });
}
function unpackAnswer(output) {
  const value=JSON.parse(output);
  if(value?.schema!==1 || packAnswer(value.message,value.finishReason)!==output) throw Error("Invalid signed native answer");
  return value;
}
module.exports={tools,calls,messages,isNative,enabled,encode,upstream,packAnswer,unpackAnswer};
