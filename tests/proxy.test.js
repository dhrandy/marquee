import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

async function run(port, trusted, checks, singleHop="0") {
 const processServer=spawn(process.execPath,["src/server.js"],{env:{...process.env,PORT:String(port),DEMO_MODE:"false",COOKIE_SECURE:"true",TRUSTED_PROXIES:trusted,TRUST_PROXY:singleHop},stdio:"ignore"});
 const base=`http://127.0.0.1:${port}`,origin=`https://127.0.0.1:${port}`;
 try {
  for(let i=0;i<100;i++) {try{if((await fetch(`${base}/api/config`)).ok)break;}catch{} await new Promise(r=>setTimeout(r,20));}
  const login=async(ip,customOrigin=origin)=>fetch(`${base}/api/login`,{method:"POST",headers:{Origin:customOrigin,"Content-Type":"application/json","X-Forwarded-For":ip},body:'{"username":{},"password":[]}'});
  await checks(login,base);
 } finally {processServer.kill(); await new Promise(resolve=>processServer.once("exit",resolve));}
}
test("trusted proxy client IP isolation, safe chain walking, and HTTPS-only writes",async()=>{
 await run(18749,"127.0.0.1",async(login,base)=>{
  assert.equal((await login("192.0.2.10",base)).status,403);
  for(let i=0;i<10;i++)assert.equal((await login("192.0.2.10")).status,400);
  assert.equal((await login("192.0.2.10")).status,429);
  assert.equal((await login("192.0.2.11")).status,400);
  // Leftmost attacker-chosen entries do not bypass the nearest untrusted IP.
  assert.equal((await login("198.51.100.3, 192.0.2.10")).status,429);
 });
});
test("untrusted sender cannot rotate spoofed X-Forwarded-For to evade login limit",async()=>{
 await run(18750,"",async(login)=>{
  for(let i=0;i<10;i++)assert.equal((await login(`192.0.2.${i+1}`)).status,400);
  assert.equal((await login("198.51.100.99")).status,429);
 });
});

test("opt-in single-hop mode counts nearest forwarded client, not spoofed leftmost",async()=>{
 await run(18751,"",async(login)=>{
  for(let i=0;i<10;i++)assert.equal((await login("198.51.100.1, 192.0.2.10")).status,400);
  assert.equal((await login("198.51.100.2, 192.0.2.10")).status,429);
  assert.equal((await login("192.0.2.11")).status,400);
 },"1");
});
