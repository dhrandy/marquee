import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { upstream } from "./adapters.js";
import { normalizeSeerrResults } from "./model.js";
const DAY=86400000;
let directory, pending, failedUntil=0, directoryPath=null;
const details=new Map();
const fold=value=>String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
export function matchNetworks(rows,query) {
  const q=fold(query); if(q.length<3) return [];
  const tokens=q.split(" ");
  return rows.filter(row=>tokens.every(token=>fold(row.name).split(" ").some(word=>word.startsWith(token))))
    .sort((a,b)=>Number(fold(b.name)===q)-Number(fold(a.name)===q)||a.name.length-b.name.length||a.id-b.id).slice(0,8);
}
export async function networkDirectory(dataDir) {
  if(directoryPath!==dataDir){directory=null;pending=null;failedUntil=0;directoryPath=dataDir;}
  if(directory && Date.now()-directory.fetchedAt<DAY) return directory.rows;
  if(pending) return pending;
  if(Date.now()<failedUntil) { if(directory) return directory.rows; throw new Error("Network list temporarily unavailable."); }
  pending=(async()=>{
    const file=path.join(dataDir,"network-list.json");
    const valid=rows=>Array.isArray(rows)&&rows.length<=30000&&rows.every(r=>Number.isSafeInteger(r.id)&&r.id>0&&typeof r.name==="string"&&r.name.length<=200);
    if(!directory)try {const saved=JSON.parse(await fs.readFile(file,"utf8"));if(valid(saved.rows)&&Number.isFinite(saved.fetchedAt)&&saved.fetchedAt<=Date.now())directory=saved;}catch{}
    if(directory&&Date.now()-directory.fetchedAt<DAY)return directory.rows;
    // UTC export date, after the published 08:00 UTC completion time.
    const now=new Date(); if(now.getUTCHours()<8)now.setUTCDate(now.getUTCDate()-1);
    const stamp=`${String(now.getUTCMonth()+1).padStart(2,"0")}_${String(now.getUTCDate()).padStart(2,"0")}_${now.getUTCFullYear()}`;
    const response=await fetch(`https://files.tmdb.org/p/exports/tv_network_ids_${stamp}.json.gz`,{signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error("Network list temporarily unavailable.");
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>1000000)throw new Error("Network list too large.");chunks.push(chunk);}
    const text=gunzipSync(Buffer.concat(chunks),{maxOutputLength:4000000}).toString("utf8");
    const rows=text.trim().split("\n").map(line=>JSON.parse(line)).map(r=>({id:r.id,name:r.name}));
    if(!valid(rows)||!rows.length)throw new Error("Invalid network list.");
    directory={fetchedAt:Date.now(),rows};await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(file+".tmp",JSON.stringify(directory));await fs.rename(file+".tmp",file);return rows;
  })().catch(error=>{failedUntil=Date.now()+60000;if(directory)return directory.rows;throw error;}).finally(()=>{pending=null;});return pending;
}
export async function networkMatches(query,dataDir) {
  const rows=matchNetworks(await networkDirectory(dataDir),query);
  return Promise.all(rows.map(async row=>{
    const key=JSON.stringify([process.env.TMDB_API_KEY,row.id]);const hit=details.get(key);
    if(hit&&hit.until>Date.now())return hit.value;
    for(const [old,entry] of details)if(entry.until<=Date.now())details.delete(old);
    if(details.size>=200)details.delete(details.keys().next().value);
    const entry={until:Date.now()+DAY,value:null};
    entry.value=(async()=>{
      let value={...row,country:null};
      if(process.env.TMDB_API_KEY)try {
        const data=await upstream("https://api.themoviedb.org",`/3/network/${row.id}?${new URLSearchParams({api_key:process.env.TMDB_API_KEY})}`);
        if(data.id===row.id&&typeof data.name==="string"&&data.name.length<=200)value={id:row.id,name:data.name,country:/^[A-Z]{2}$/.test(data.origin_country)?data.origin_country:null};
      }catch {entry.until=Date.now()+60000;}
      return value;
    })();
    details.set(key,entry);return entry.value;
  }));
}
export async function networkShows(id,page,userId,dataDir, { read = upstream, rows = null } = {}) {
  if(!Number.isSafeInteger(id)||id<1||!Number.isInteger(page)||page<1||page>500)throw new Error("Invalid network page.");
  const network=(rows || await networkDirectory(dataDir)).find(r=>r.id===id);if(!network)throw new Error("Unknown network.");
  const today=new Date().toISOString().slice(0,10);
  const query=new URLSearchParams({network:String(id),page:String(page),sortBy:"first_air_date.desc",firstAirDateLte:today});
  const data=await read(process.env.SEERR_URL,`/api/v1/discover/tv?${query}`,{headers:{"X-Api-Key":process.env.SEERR_API_KEY,"X-API-User":String(userId)}});
  return {network,results:normalizeSeerrResults({results:(data.results||[]).map(r=>({...r,mediaType:"tv"}))}).filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(r.date)&&Number.isFinite(Date.parse(r.date+"T00:00:00Z"))&&new Date(r.date+"T00:00:00Z").toISOString().slice(0,10)===r.date&&r.date<=today),totalPages:Number.isInteger(data.totalPages)?data.totalPages:1};
}
