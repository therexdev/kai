"use strict";
const { uint } = require("./policy");
function preferences(freeOnly = false, paidFirst = false) {
  if (typeof freeOnly !== "boolean") throw Error("Invalid Free only preference");
  if (typeof paidFirst !== "boolean") throw Error("Invalid paid credit priority");
  if (freeOnly && paidFirst) throw Error("Free only and paid-first cannot both be enabled");
}
// A quote allocates its ceiling in the chosen order. The caller checks BOTH
// sources: the remainder can exceed its balance when funds are insufficient.
// The same function consumes the reserved portions for each delivered prefix.
function split(amount, freeAvailable, paidAvailable, paidFirst = false) {
  const total = uint(amount), free = uint(freeAvailable), paid = uint(paidAvailable);
  const first = paidFirst ? (paid < total ? paid : total) : (free < total ? free : total);
  return paidFirst ? { free: total - first, paid: first } : { free: first, paid: total - first };
}
module.exports = { preferences, split };
