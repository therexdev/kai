"use strict";
const USD_PRODUCT = "prepaid-usd-v1";
const MASTER_NODE = "15CM9Qr4GKREDgqnyXJ8tckPj2biERTM1T";
const isPrepaid = value => ["prepaid-v1", USD_PRODUCT].includes(typeof value === "string" ? value : value?.product);
const isUsd = value => (typeof value === "string" ? value : value?.product) === USD_PRODUCT;
module.exports = { USD_PRODUCT, MASTER_NODE, isPrepaid, isUsd };
