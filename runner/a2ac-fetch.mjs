#!/usr/bin/env node
import {createWriteStream} from "node:fs";
import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {basename,dirname,join} from "node:path";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";

const args=process.argv.slice(2),id=args[0],option=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
if(!id||id.startsWith("-")){console.error("Usage: a2ac-fetch <attachment-id> [--output file-or-directory]");process.exit(2);}
const configPath=process.env.A2AC_RUNNER_CONFIG||join(homedir(),".config/a2ac-runner/config.json"),config=JSON.parse(await readFile(configPath,"utf8"));
const response=await fetch(`${config.serverUrl}/api/attachments/${encodeURIComponent(id)}`,{headers:{authorization:`Bearer ${config.agentKey}`}});
if(!response.ok||!response.body){console.error(`A2Ac download failed (${response.status}): ${await response.text()}`);process.exit(1);}
const disposition=response.headers.get("content-disposition")||"",match=disposition.match(/filename\*=UTF-8''([^;]+)/i),remoteName=match?decodeURIComponent(match[1]):id;
let output=option("--output")||remoteName;
if(output.endsWith("/")||output.endsWith("\\"))output=join(output,remoteName);
await pipeline(Readable.fromWeb(response.body),createWriteStream(output));
console.log(`Downloaded ${remoteName} to ${output}`);
