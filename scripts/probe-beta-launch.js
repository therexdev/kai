"use strict";
const {execFileSync}=require("node:child_process");
execFileSync(process.execPath,["--test","tests/beta-launch.test.js"],{cwd:require("node:path").join(__dirname,".."),stdio:"inherit"});
