import {
  assertDashboardLocale,
  getDashboardCopy,
  type DashboardLocale,
} from "./dashboard-copy.js";

export type LiveDashboardAssets = Readonly<{
  shellHtml: string;
  clientJavaScript: string;
  styleSheet: string;
}>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function shell(locale: DashboardLocale): string {
  const copy = getDashboardCopy(locale);
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(copy["live.title"])}</title><link rel="stylesheet" href="app.css"><script type="module" src="client.js"></script></head><body><main id="embassy-live" aria-live="polite"></main><noscript>${escapeHtml(copy["live.noscript"])}</noscript></body></html>`;
}

function client(locale: DashboardLocale): string {
  const copies = {
    en: getDashboardCopy("en"),
    "zh-CN": getDashboardCopy("zh-CN"),
  };
  return `"use strict";
const COPY=${JSON.stringify(copies)};
let locale=${JSON.stringify(locale)};
let latest;
let controller;
let filter="";
let connectionState="connecting";
const root=document.getElementById("embassy-live");
const base=location.pathname.endsWith("/bootstrap")?location.pathname.slice(0,-10):(location.pathname.endsWith("/")?location.pathname.slice(0,-1):location.pathname);
const api=(name)=>base+"/"+name;
const t=(key,values={})=>(COPY[locale][key]||key).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g,(match,name)=>Object.prototype.hasOwnProperty.call(values,name)?String(values[name]):match);
const el=(name,className,text)=>{const node=document.createElement(name);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;};
const append=(parent,...children)=>{for(const child of children)parent.append(child);return parent;};
const button=(label,action)=>{const node=el("button","button",label);node.type="button";node.addEventListener("click",action);return node;};
const apiFetch=(name,options={})=>fetch(api(name),{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"X-Embassy-Request":"1",...(options.headers||{})},body:options.body,signal:options.signal});
const connectionTone=()=>connectionState==="connected"?"good":connectionState==="paused"?"paused":connectionState==="unavailable"||connectionState==="disconnected"||connectionState==="stopped"?"warning":"";
function setConnectionState(state){connectionState=state;const node=document.getElementById("live-status");if(node){node.textContent=t("live.connection."+state);node.dataset.tone=connectionTone();}}
function partyCard(kind,party){const card=el("article","party-card");append(card,el("p","eyebrow",kind==="claude"?t("exchange.claude.title"):t("exchange.codex.title")),el("h3","",party.primaryAlias||t("status.missing")),el("p","status",t("status."+party.status)),el("p","quiet",t("next.label")+": "+t({discover_claude:"next.discoverClaude",select_claude:"next.selectClaude",restore_claude:"next.restoreClaude",repair_claude_inventory:"next.repairClaude",register_codex:"next.registerCodex",restore_codex:"next.restoreCodex",none:"next.none"}[party.nextAction])));return card;}
function table(headers,rows){const wrap=el("div","table-wrap");const table=el("table");const head=el("thead");const hr=el("tr");for(const value of headers)hr.append(el("th","",value));head.append(hr);const body=el("tbody");for(const row of rows){const tr=el("tr");for(const value of row)tr.append(el("td","",value));body.append(tr);}append(table,head,body);wrap.append(table);return wrap;}
function render(){if(!latest)return;const model=latest.model;document.title=t("live.title");root.replaceChildren();const header=el("header","masthead");const title=el("div");append(title,el("p","eyebrow",t("live.label")),el("h1","",t("brand.title")),el("p","lede",t("live.mastheadSubtitle")));const controls=el("div","controls");const language=el("select","select");language.setAttribute("aria-label",t("language.label"));for(const code of ["en","zh-CN"]){const option=el("option","",code==="en"?t("language.en"):t("language.zhCn"));option.value=code;option.selected=code===locale;language.append(option);}language.addEventListener("change",()=>{locale=language.value;document.documentElement.lang=locale;document.title=t("live.title");render();});const search=el("input","filter");search.type="search";search.placeholder=t("live.filter.placeholder");search.value=filter;search.addEventListener("input",()=>{filter=search.value.toLowerCase();render();const next=document.querySelector(".filter");if(next){next.focus();next.setSelectionRange(next.value.length,next.value.length);}});append(controls,language,search,button(t("live.control.pause"),()=>{if(controller)controller.abort();setConnectionState("paused");}),button(t("live.control.reconnect"),connect),button(t("live.control.refresh"),readNow));append(header,title,controls);root.append(header);
const status=el("p","live-status",t("live.connection."+connectionState));status.id="live-status";status.dataset.tone=connectionTone();root.append(status);if(latest.reset)root.append(el("p","notice",t("live.stream.reset")));
const exchange=el("section","panel");append(exchange,el("p","eyebrow",t("exchange.eyebrow")),el("h2","",t("exchange.title")));const parties=el("div","party-grid");append(parties,partyCard("claude",model.exchange.claude),partyCard("codex",model.exchange.codex));exchange.append(parties);root.append(exchange);
const metrics=el("section","metric-grid");append(metrics,append(el("article","metric"),el("strong","",model.transit.queuedMessages),el("span","",t("live.metric.queued"))),append(el("article","metric"),el("strong","",model.transit.activeDeliveries),el("span","",t("live.metric.active"))),append(el("article","metric"),el("strong","",latest.streamRevision),el("span","",t("live.metric.revision"))));root.append(metrics);
const guidanceKeys={reobserve_claude:"reobserveClaude",reobserve_codex:"reobserveCodex",claude_not_observed:"claudeNotObserved",codex_stale:"codexStale",connector_offline:"connectorOffline",route_stale:"routeStale",queue_stalled:"queueStalled",unconfirmed:"unconfirmed",degraded:"degraded",codex_succession_busy:"codexSuccessionBusy",codex_succession_recovery:"codexSuccessionRecovery",generic:"generic"};const attention=el("section","panel");append(attention,el("p","eyebrow",t("attention.eyebrow")),el("h2","",t("attention.title")));if(model.attention.length===0)attention.append(el("p","quiet",t("live.attention.empty")));for(const item of model.attention){const key=guidanceKeys[item.guidance]||"generic";const row=el("article","attention-row");const detail=el("div","attention-copy");append(detail,el("strong","",t("guidance."+key+".title")));if(item.code)detail.append(el("code","",item.code));append(detail,el("p","quiet",t("guidance."+key+".body")),el("p","quiet",t("next.label")+": "+t("guidance."+key+".action")));append(row,detail,el("span","",item.alias||item.host||item.provider||item.kind));attention.append(row);}root.append(attention);
const term=filter;const activity=model.activity.filter((item)=>!term||[item.sourceAlias,item.targetAlias,item.state,item.safeErrorCode||""].join(" ").toLowerCase().includes(term));const activityPanel=el("section","panel");append(activityPanel,el("p","eyebrow",t("activity.eyebrow")),el("h2","",t("activity.title")));if(activity.length===0)activityPanel.append(el("p","quiet",t("live.activity.empty")));else activityPanel.append(table([t("activity.column.updated"),t("activity.column.route"),t("activity.column.result"),t("activity.column.size")],activity.map((item)=>[item.timestamp||"—",item.sourceAlias+" → "+item.targetAlias,t("delivery."+item.state.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())),item.bytes])));root.append(activityPanel);
const peers=model.peers.filter((item)=>!term||(item.alias+" "+item.host).toLowerCase().includes(term));const routes=model.routes.filter((item)=>!term||(item.alias+" "+item.host+" "+item.provider).toLowerCase().includes(term));const sessions=document.createElement("details");sessions.className="panel";const summary=el("summary","",t("live.sessions.title"));sessions.append(summary,table([t("column.alias"),t("column.state"),t("column.selection")],peers.map((item)=>[item.alias,t("peer."+item.state.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())),item.selected?t("status.selected"):t("status.available")])),table([t("column.alias"),t("column.provider"),t("column.state"),t("column.queue")],routes.map((item)=>[item.alias,t("provider."+item.provider),t("route."+item.state.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())),item.queueDepth])));root.append(sessions);
const diagnostics=document.createElement("details");diagnostics.className="panel";diagnostics.append(el("summary","",t("live.diagnostics.title")),el("pre","diagnostic-json",JSON.stringify({health:model.health,accounting:model.accounting,omissions:model.omissions},null,2)));root.append(diagnostics,el("footer","live-footer",t("live.readonlyFooter")));
}
async function exchangeCapability(){const capability=location.hash.slice(1);if(!capability)return;history.replaceState(null,"",location.pathname);const response=await apiFetch("session",{headers:{"Content-Type":"text/plain;charset=UTF-8"},body:capability});if(!response.ok)throw new Error("session");}
function consumeSseBlock(block){const newline=String.fromCharCode(10);let event="message";const data=[];for(const line of block.split(newline)){if(line.startsWith("event:"))event=line.slice(6).trim();if(line.startsWith("data:"))data.push(line.slice(5).trimStart());}if(event==="snapshot"&&data.length){latest=JSON.parse(data.join(newline));setConnectionState("connected");render();}else if(event==="observer_unavailable")setConnectionState("unavailable");else if(event==="shutdown")setConnectionState("stopped");}
async function connect(){if(controller)controller.abort();const current=new AbortController();controller=current;setConnectionState("connecting");try{const response=await apiFetch("stream",{signal:current.signal});if(!response.ok||!response.body)throw new Error("stream");const reader=response.body.getReader();const decoder=new TextDecoder();const newline=String.fromCharCode(10);let buffer="";while(true){const result=await reader.read();if(result.done)break;buffer+=decoder.decode(result.value,{stream:true}).replaceAll(String.fromCharCode(13)+newline,newline);if(buffer.length>1048576)throw new Error("frame");let boundary;while((boundary=buffer.indexOf(newline+newline))>=0){consumeSseBlock(buffer.slice(0,boundary));buffer=buffer.slice(boundary+2);}}if(!current.signal.aborted&&connectionState!=="stopped")setConnectionState("disconnected");}catch(error){if(!current.signal.aborted)setConnectionState("disconnected");}}
async function readNow(){try{const response=await apiFetch("snapshot");if(response.ok){latest=await response.json();render();}else setConnectionState(connectionState==="connected"?"unavailable":"disconnected");}catch{setConnectionState(connectionState==="connected"?"unavailable":"disconnected");}}
async function start(){try{const status=el("p","live-status",t("live.connection."+connectionState));status.id="live-status";root.replaceChildren(status);await exchangeCapability();await connect();}catch{connectionState="disconnected";root.replaceChildren(el("p","fatal",t("live.connection.fatal")));}}
void start();
`;
}

const STYLE_SHEET = `
:root{color-scheme:light;--paper:#f5f0e7;--surface:#fffdf8;--ink:#1f2527;--muted:#68665f;--line:#d9d0c2;--seal:#b63a2d;--good:#2d6950;--shadow:0 18px 50px rgba(41,34,25,.08);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--paper);color:var(--ink)}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 86% 0,rgba(182,58,45,.08),transparent 27rem),var(--paper)}main{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:44px 0 80px}.masthead{display:flex;justify-content:space-between;gap:28px;align-items:flex-end;padding:0 4px 28px;border-bottom:1px solid var(--line)}h1{font-family:ui-serif,Georgia,serif;font-size:clamp(3rem,8vw,6.4rem);line-height:.9;letter-spacing:-.06em;margin:.08em 0}.eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:.72rem;font-weight:750;color:var(--seal)}.lede,.quiet{color:var(--muted)}.controls{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.button,.select,.filter{border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--ink);padding:9px 13px;font:inherit}.button{cursor:pointer}.button:hover{border-color:var(--seal)}.filter{min-width:220px}.live-status{display:inline-block;margin:18px 4px 0;padding:7px 11px;border-radius:999px;background:#e5eee8;color:var(--good);font-weight:700;font-size:.82rem}.live-status[data-tone=warning]{background:#f6e2d8;color:#8b321f}.live-status[data-tone=paused]{background:#e8e4dc;color:var(--muted)}.notice{border-left:3px solid var(--seal);padding:10px 14px;background:rgba(255,255,255,.45)}.panel{margin-top:18px;padding:24px;border:1px solid var(--line);border-radius:18px;background:rgba(255,253,248,.82);box-shadow:var(--shadow)}.panel h2{font-family:ui-serif,Georgia,serif;font-size:1.8rem;margin:.2em 0 1em}.party-grid,.metric-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.party-card,.metric{border:1px solid var(--line);background:var(--surface);border-radius:14px;padding:18px}.party-card h3{margin:.25em 0;word-break:break-word}.status{font-weight:750}.metric-grid{grid-template-columns:repeat(3,minmax(0,1fr));margin-top:18px}.metric{display:flex;flex-direction:column}.metric strong{font-family:ui-serif,Georgia,serif;font-size:2.5rem}.metric span{color:var(--muted)}.attention-row{display:flex;justify-content:space-between;gap:14px;padding:12px 0;border-top:1px solid var(--line)}.attention-copy{min-width:0}.attention-copy code{display:inline-block;margin:.35rem 0 0}.attention-copy p{margin:.35rem 0 0}.table-wrap{overflow:auto;margin-top:14px}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:11px 12px;border-bottom:1px solid var(--line);white-space:nowrap}th{font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}summary{cursor:pointer;font-family:ui-serif,Georgia,serif;font-size:1.4rem;font-weight:700}.diagnostic-json{overflow:auto;font-size:.76rem;color:var(--muted)}.live-footer{margin:28px 4px 0;color:var(--muted);font-size:.78rem;text-align:center}.fatal{margin:20vh auto;padding:24px;max-width:36rem;border:1px solid var(--line);background:var(--surface)}@media(max-width:760px){main{width:min(100% - 20px,1180px);padding-top:24px}.masthead{align-items:flex-start;flex-direction:column}.controls{justify-content:flex-start}.party-grid,.metric-grid{grid-template-columns:1fr}.filter{width:100%}}
`;

export function renderLiveDashboardAssets(
  locale: DashboardLocale,
): LiveDashboardAssets {
  assertDashboardLocale(locale);
  return {
    shellHtml: shell(locale),
    clientJavaScript: client(locale),
    styleSheet: STYLE_SHEET,
  };
}
