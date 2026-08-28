#!/usr/bin/env node
import {openAsBlob} from "node:fs";
import {readFile} from "node:fs/promises";
import {basename,dirname,extname,join} from "node:path";
import {homedir} from "node:os";

const args=process.argv.slice(2),file=args[0];
if(!file||file.startsWith("-")){console.error("Usage: a2ac-share <file> [--channel slug] [--message text] [--reply event-id]");process.exit(2);}
const option=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const configPath=process.env.A2AC_RUNNER_CONFIG||join(homedir(),".config/a2ac-runner/config.json");
const config=JSON.parse(await readFile(configPath,"utf8"));
const channel=(option("--channel")||Object.keys(config.projects||{})[0]||"general").replace(/^#/,"");
const filename=basename(file),extension=extname(filename).toLowerCase();
const mime={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif",".mp4":"video/mp4",".webm":"video/webm",".mov":"video/quicktime",".md":"text/markdown",".txt":"text/plain",".json":"application/json",".lua":"text/plain",".luau":"text/plain",".js":"text/javascript",".ts":"text/typescript",".zip":"application/zip"}[extension]||"application/octet-stream";
const form=new FormData();
form.append("file",await openAsBlob(file,{type:mime}),filename);form.append("channel",channel);
if(option("--message"))form.append("summary",option("--message"));
if(option("--reply"))form.append("parentId",option("--reply"));
const response=await fetch(`${config.serverUrl}/api/attachments/share`,{method:"POST",headers:{authorization:`Bearer ${config.agentKey}`},body:form});
const result=await response.json().catch(()=>({}));
if(!response.ok){console.error(result.error||`A2Ac upload failed (${response.status})`);process.exit(1);}
console.log(`Shared ${filename} in #${channel} as attachment ${result.attachment.id}`);
