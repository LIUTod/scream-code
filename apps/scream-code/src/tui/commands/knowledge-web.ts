/**
 * /knowledge web — 知识图谱可视化
 * 纯 Canvas 2D 自渲染（无任何外部依赖/CDN），打开即用。
 * 白底简约科技风：灰色小点星云 + 细黑线条 + 放大显示文字。
 */

import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { KnowledgeStore } from '@scream-code/knowledge';
import { t, getLocale } from '@scream-code/config';

import { openUrl } from '../utils/open-url';
import { getKnowledgeStore } from './knowledge-store';
import type { SlashCommandHost } from './dispatch';

// ─── Server lifecycle ────────────────────────────────────────────────

const activeServers = new Set<Server>();

function registerServer(server: Server): void {
  activeServers.add(server);
  server.on('close', () => { activeServers.delete(server); });
}

function closeAllServers(): void {
  for (const server of activeServers) {
    server.close();
  }
}

process.on('exit', closeAllServers);

// ─── HTML template ──────────────────────────────────────────────────

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title data-msg="kw_title">__MSG_kw_title__</title>
<style>
:root{
  --bg:#fafafa;--bg-soft:#f0f0f0;
  --ink:#1a1a1a;--ink-dim:#666;--ink-faint:#999;--ink-mute:#ccc;
  --line:#1a1a1a;--line-soft:rgba(0,0,0,.08);
  --accent:#0066ff;--accent-soft:rgba(0,102,255,.08);
}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:var(--ink)}
body{background:var(--bg)}
#scene{position:fixed;inset:0;z-index:1;display:block;cursor:grab}
#scene:active{cursor:grabbing}

.label-3d{
  position:absolute;pointer-events:none;z-index:5;left:0;top:0;
  font-size:10px;font-weight:500;color:var(--ink-dim);
  white-space:nowrap;letter-spacing:.2px;
  padding:1px 5px;border-radius:3px;
  background:rgba(250,250,250,.85);
  will-change:transform;
  transition:color .2s;
}
.label-3d.root{color:var(--ink);font-weight:600;font-size:11px}
.label-3d.selected{color:#0d7a3e;font-weight:600;background:rgba(255,255,255,.95)}
.label-3d.hover{color:var(--ink);background:rgba(255,255,255,.95)}

#toolbar{
  position:fixed;left:20px;top:20px;z-index:10;display:flex;align-items:center;gap:10px;
  background:rgba(255,255,255,.9);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  border:1px solid var(--line-soft);border-radius:10px;padding:8px 14px;
  box-shadow:0 2px 12px rgba(0,0,0,.04);
}
#toolbar button{
  background:transparent;color:var(--ink-dim);border:1px solid transparent;
  padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;
  transition:all .15s;letter-spacing:.2px;
}
#toolbar button:hover{background:var(--accent-soft);color:var(--accent);border-color:var(--accent-soft)}
#toolbar .sep{width:1px;height:16px;background:var(--line-soft)}
#toolbar .chip{color:var(--ink-faint);font-size:10px;letter-spacing:.3px;font-weight:500}
#toolbar .chip b{color:var(--ink);font-size:13px;font-weight:600;margin-left:5px}

#search-wrap{
  position:relative;display:flex;align-items:center;
  background:var(--bg-soft);border:1px solid transparent;border-radius:6px;
  padding:0 8px 0 26px;transition:all .15s;
}
#search-wrap:focus-within{border-color:var(--accent);background:#fff;box-shadow:0 0 0 3px var(--accent-soft)}
#search-icon{position:absolute;left:8px;color:var(--ink-faint);pointer-events:none}
#search-wrap:focus-within #search-icon{color:var(--accent)}
#search-input{
  background:transparent;border:none;outline:none;color:var(--ink);
  font-size:12px;width:150px;padding:5px 0;
}
#search-input::placeholder{color:var(--ink-faint)}

#hint{position:fixed;left:20px;bottom:16px;z-index:10;color:var(--ink-faint);font-size:11px;letter-spacing:.2px;line-height:1.6}
#hint b{color:var(--ink-dim);font-weight:500}

#modal-mask{position:fixed;inset:0;z-index:30;opacity:0;pointer-events:none;transition:opacity .25s}
#modal-mask.open{opacity:0;pointer-events:auto}
#modal{
  position:fixed;right:20px;top:50%;transform:translateY(-50%) translateX(20px);z-index:31;
  width:360px;max-width:calc(100vw - 40px);max-height:calc(100vh - 40px);overflow-y:auto;
  background:rgba(255,255,255,.96);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border:1px solid var(--line-soft);border-radius:12px;padding:24px;
  box-shadow:0 8px 40px rgba(0,0,0,.08);
  opacity:0;pointer-events:none;transition:all .3s cubic-bezier(.4,0,.2,1);
  scroll-behavior:smooth;
}
#modal.open{opacity:1;transform:translateY(-50%) translateX(0);pointer-events:auto}
#modal::-webkit-scrollbar{width:4px}
#modal::-webkit-scrollbar-thumb{background:var(--ink-mute);border-radius:2px}
#modal .close{
  position:absolute;top:16px;right:16px;background:transparent;border:none;
  color:var(--ink-faint);cursor:pointer;font-size:18px;width:28px;height:28px;
  display:flex;align-items:center;justify-content:center;border-radius:6px;transition:all .15s;
}
#modal .close:hover{color:var(--ink);background:var(--bg-soft)}
#modal .type-tag{display:inline-block;font-size:10px;color:var(--accent);background:var(--accent-soft);border-radius:4px;padding:2px 8px;font-weight:600;margin-bottom:14px;letter-spacing:.3px;text-transform:uppercase}
#modal .type-tag.event{color:#9333ea;background:rgba(147,51,234,.08)}
#modal h3{font-size:17px;font-weight:600;color:var(--ink);margin-bottom:20px;padding-right:36px;line-height:1.4}
#modal .field{margin-bottom:16px}
#modal .field .label{font-size:10px;color:var(--ink-faint);text-transform:uppercase;letter-spacing:1px;font-weight:600;margin-bottom:6px}
#modal .field .value{font-size:13px;color:var(--ink-dim);line-height:1.6}
#modal .conn-item{
  font-size:12px;color:var(--ink);cursor:pointer;padding:8px 12px;border-radius:6px;
  transition:all .12s;border:1px solid transparent;background:var(--bg-soft);margin-bottom:4px;
  display:flex;align-items:center;justify-content:space-between;
}
#modal .conn-item:hover{background:var(--accent-soft);color:var(--accent)}
#modal .conn-item:focus{outline:none;border-color:var(--accent)}
#modal .badge{font-size:9px;color:var(--ink-faint);background:transparent;border:1px solid var(--line-soft);border-radius:3px;padding:1px 6px;font-weight:500;letter-spacing:.2px;text-transform:uppercase}
#modal .back-btn{
  display:inline-flex;align-items:center;gap:5px;background:transparent;border:1px solid var(--line-soft);
  color:var(--ink-dim);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:500;
  margin-bottom:16px;transition:all .15s;
}
#modal .back-btn:hover{background:var(--bg-soft);color:var(--ink)}
#modal .divider{height:1px;background:var(--line-soft);margin:18px 0}

#loading{
  position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:40;
  color:var(--ink-dim);font-size:13px;display:flex;align-items:center;gap:10px;
}
#loading .dot{width:6px;height:6px;border-radius:50%;background:var(--ink-mute);animation:pulse 1.4s ease-in-out infinite}
#loading .dot:nth-child(2){animation-delay:.2s}
#loading .dot:nth-child(3){animation-delay:.4s}
@keyframes pulse{0%,80%,100%{opacity:.3}40%{opacity:1}}
#error-msg{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:40;color:var(--ink-dim);font-size:13px;text-align:center;max-width:80vw;display:none;background:#fff;padding:24px 32px;border-radius:10px;border:1px solid var(--line-soft)}

#minimap{
  position:fixed;right:20px;bottom:20px;z-index:10;width:140px;height:140px;
  background:rgba(255,255,255,.9);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  border:1px solid var(--line-soft);border-radius:8px;padding:4px;
  box-shadow:0 2px 12px rgba(0,0,0,.04);
}
#minimap-canvas{width:100%;height:100%;display:block;cursor:crosshair}

#tooltip{
  position:fixed;z-index:20;pointer-events:none;display:none;
  background:#fff;border:1px solid var(--line-soft);border-radius:6px;padding:6px 10px;
  box-shadow:0 4px 12px rgba(0,0,0,.06);max-width:240px;
}
#tooltip .tt-name{font-size:12px;font-weight:600;color:var(--ink);margin-bottom:2px}
#tooltip .tt-meta{font-size:10px;color:var(--ink-faint)}
#tooltip .tt-summary{font-size:11px;color:var(--ink-dim);margin-top:4px;line-height:1.4}
</style>
</head>
<body>
<canvas id="scene"></canvas>
<div id="labels"></div>
<div id="toolbar">
  <span class="chip"><span data-msg="kw_entity">__MSG_kw_entity__</span><b id="stat-ent">0</b></span>
  <span class="chip"><span data-msg="kw_event">__MSG_kw_event__</span><b id="stat-evt">0</b></span>
  <span class="chip"><span data-msg="kw_relation">__MSG_kw_relation__</span><b id="stat-edg">0</b></span>
  <span class="sep"></span>
  <div id="search-wrap">
    <svg id="search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
    <input id="search-input" type="text" placeholder="__MSG_kw_search_placeholder__" autocomplete="off" spellcheck="false">
  </div>
  <span class="sep"></span>
  <button id="btn-reset" data-msg="kw_btn_reset">__MSG_kw_btn_reset__</button>
  <button id="btn-expand" data-msg="kw_btn_expand">__MSG_kw_btn_expand__</button>
  <span class="sep"></span>
  <button id="btn-lang">__MSG_kw_lang_toggle__</button>
</div>
<div id="hint"><b data-msg="kw_hint_drag">__MSG_kw_hint_drag__</b></div>
<div id="tooltip"></div>
<div id="minimap"><canvas id="minimap-canvas"></canvas></div>
<div id="modal-mask"></div>
<div id="modal"><button class="close" id="btn-close">&times;</button><div id="modal-body"></div></div>
<div id="loading"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span data-msg="kw_loading">__MSG_kw_loading__</span></div>
<div id="error-msg"></div>

<script>
var DICT=__DICT_INJECT__;
var curLang='__LOCALE_INJECT__';
function M(k){return(DICT[curLang]&&DICT[curLang][k])||k}
function applyLang(){
  document.title=M('kw_title');
  document.querySelectorAll('[data-msg]').forEach(function(el){el.textContent=M(el.dataset.msg)});
  var ph=document.getElementById('search-input');if(ph)ph.placeholder=M('kw_search_placeholder');
  document.getElementById('btn-lang').textContent=M('kw_lang_toggle');
}
function toggleLang(){
  curLang=curLang==='zh'?'en':'zh';
  applyLang();
  if(typeof render==='function')render();
}
(function(){
'use strict';

var TYPE_COLORS={
  person:'#1a1a1a',organization:'#0066ff',location:'#0891b2',time:'#d97706',
  product:'#db2777',metric:'#9333ea',action:'#dc2626',work:'#7c3aed',
  group:'#4f46e5',subject:'#0d9488',tags:'#666'
};
var INK='#1a1a1a',ACCENT='#0066ff',EVENT='#9333ea',SELECTED='#0d7a3e';

// ─── Canvas ──────────────────────────────────────────
var canvas=document.getElementById('scene');
var ctx=canvas.getContext('2d');
var labelsEl=document.getElementById('labels');
var errorMsg=document.getElementById('error-msg');
var W=0,H=0,DPR=Math.min(window.devicePixelRatio||1,2);
function resize(){
  W=window.innerWidth;H=window.innerHeight;
  canvas.width=W*DPR;canvas.height=H*DPR;
  canvas.style.width=W+'px';canvas.style.height=H+'px';
  ctx.setTransform(DPR,0,0,DPR,0,0);
}
resize();
window.addEventListener('resize',function(){resize();markDirty()});

// 相机
var camRotX=0.25,camRotY=0.4;
var camDist=500;
var camTargetX=0,camTargetY=0,camTargetZ=0;
var fov=600;

// ─── 数据 ────────────────────────────────────────────
var eById={},evById={};
var evByEnt={},entByEv={};
var expEnt=new Set(),expEv=new Set();
var selId=null;
var navStack=[];
var graphData;
var nodePositions={};
var nodeData=[];

// ─── 3D 投影 ──────────────────────────────────────────
function project(p){
  var cosY=Math.cos(camRotY),sinY=Math.sin(camRotY);
  var cosX=Math.cos(camRotX),sinX=Math.sin(camRotX);
  var x1=p.x*cosY - p.z*sinY;
  var z1=p.x*sinY + p.z*cosY;
  var y1=p.y;
  var y2=y1*cosX - z1*sinX;
  var z2=y1*sinX + z1*cosX;
  var x2=x1;
  var x3=x2 - camTargetX;
  var y3=y2 - camTargetY;
  var z3=z2 - camTargetZ + camDist;
  if(z3<1)z3=1;
  var scale=fov/z3;
  return{x:W/2 + x3*scale, y:H/2 - y3*scale, z:z3, scale:scale};
}

// ─── 力导向布局 ──────────────────────────────────────
function forceLayout3D(){
  var k=100,repulsion=6000,attraction=0.06,centerForce=0.008,damping=0.85;
  for(var iter=0;iter<200;iter++){
    var forces={};
    for(var i=0;i<nodeData.length;i++){forces[nodeData[i].id]={x:0,y:0,z:0}}
    for(var a=0;a<nodeData.length;a++){
      var na=nodeData[a];
      for(var b=a+1;b<nodeData.length;b++){
        var nb=nodeData[b];
        var pa=nodePositions[na.id],pb=nodePositions[nb.id];
        var dx=pa.x-pb.x,dy=pa.y-pb.y,dz=pa.z-pb.z;
        var dist=Math.sqrt(dx*dx+dy*dy+dz*dz)+0.01;
        var force=repulsion/(dist*dist);
        var fx=dx/dist*force,fy=dy/dist*force,fz=dz/dist*force;
        forces[na.id].x+=fx;forces[na.id].y+=fy;forces[na.id].z+=fz;
        forces[nb.id].x-=fx;forces[nb.id].y-=fy;forces[nb.id].z-=fz;
      }
    }
    graphData.edges.forEach(function(e){
      var pa=nodePositions[e.entityId],pb=nodePositions[e.eventId];
      if(!pa||!pb)return;
      var dx=pb.x-pa.x,dy=pb.y-pa.y,dz=pb.z-pa.z;
      var dist=Math.sqrt(dx*dx+dy*dy+dz*dz)+0.01;
      var force=(dist-k)*attraction;
      var fx=dx/dist*force,fy=dy/dist*force,fz=dz/dist*force;
      forces[e.entityId].x+=fx;forces[e.entityId].y+=fy;forces[e.entityId].z+=fz;
      forces[e.eventId].x-=fx;forces[e.eventId].y-=fy;forces[e.eventId].z-=fz;
    });
    nodeData.forEach(function(n){
      if(n.isRoot)return;
      var p=nodePositions[n.id];var f=forces[n.id];
      p.vx=(p.vx||0)*damping+f.x;
      p.vy=(p.vy||0)*damping+f.y;
      p.vz=(p.vz||0)*damping+f.z;
      p.x+=p.vx;p.y+=p.vy;p.z+=p.vz;
      p.x-=p.x*centerForce;p.y-=p.y*centerForce;p.z-=p.z*centerForce;
    });
  }
  var allPos=nodeData.map(function(n){return nodePositions[n.id]}).filter(function(p){return p});
  var cx=0,cy=0,cz=0;
  allPos.forEach(function(p){cx+=p.x;cy+=p.y;cz+=p.z});
  cx/=allPos.length;cy/=allPos.length;cz/=allPos.length;
  nodeData.forEach(function(n){nodePositions[n.id].x-=cx;nodePositions[n.id].y-=cy;nodePositions[n.id].z-=cz});
}

function getVisible(){
  var ve=new Set(),vv=new Set();
  graphData.entities.slice(0,8).forEach(function(e){ve.add(e.id)});
  expEnt.forEach(function(eid){ve.add(eid);(evByEnt[eid]||[]).forEach(function(v){vv.add(v)})});
  expEv.forEach(function(eid){vv.add(eid);(entByEv[eid]||[]).forEach(function(e){ve.add(e)})});
  return{entities:ve,events:vv};
}

function toggleNode(id,kind){
  if(kind==='entity'){
    if(expEnt.has(id)){
      expEnt.delete(id);
      var related=new Set(evByEnt[id]||[]);
      expEv.forEach(function(eid){if(related.has(eid))expEv.delete(eid)});
    }else expEnt.add(id);
  }else{
    if(expEv.has(id))expEv.delete(id);
    else expEv.add(id);
  }
}

// ─── 星云背景：灰色小点簇，不闪烁慢漂浮 ────────────────
// 围绕每个事件节点生成一团散点，构成"星云"
var nebulaDots=[];
function buildNebulae(){
  nebulaDots=[];
  if(!graphData)return;
  graphData.events.forEach(function(ev){
    var p=nodePositions[ev.id];if(!p)return;
    // 每个事件周围撒 30-50 个小灰点
    var count=25+Math.floor(Math.random()*20);
    for(var i=0;i<count;i++){
      var theta=Math.random()*Math.PI*2;
      var phi=Math.acos(2*Math.random()-1);
      var r=8+Math.random()*35;
      nebulaDots.push({
        baseX:p.x+r*Math.sin(phi)*Math.cos(theta),
        baseY:p.y+r*Math.sin(phi)*Math.sin(theta),
        baseZ:p.z+r*Math.cos(phi),
        size:0.5+Math.random()*0.8,
        op:0.15+Math.random()*0.2
      });
    }
  });
}

function drawNebulae(){
  ctx.save();
  for(var i=0;i<nebulaDots.length;i++){
    var d=nebulaDots[i];
    var p=project({x:d.baseX,y:d.baseY,z:d.baseZ});
    if(p.z<=0)continue;
    var r=Math.max(0.3,d.size*p.scale*0.5);
    if(r<0.4)continue;
    var alpha=d.op*Math.min(1,p.scale*1.5);
    ctx.fillStyle='rgba(0,0,0,'+alpha.toFixed(3)+')';
    ctx.beginPath();
    ctx.arc(p.x,p.y,r,0,Math.PI*2);
    ctx.fill();
  }
  ctx.restore();
}

// ─── 边：细黑线 ──────────────────────────────────────
function drawEdges(projMap,connSet){
  if(!graphData)return;
  graphData.edges.forEach(function(e){
    var visAll=projMap.allIds;
    if(!visAll.has(e.entityId)||!visAll.has(e.eventId))return;
    var pa=projMap[e.entityId],pb=projMap[e.eventId];
    if(!pa||!pb)return;
    if(pa.z<=0||pb.z<=0)return;
    var isDir=selId&&(e.entityId===selId||e.eventId===selId);
    var inConn=!connSet||connSet.has(e.entityId)&&connSet.has(e.eventId);
    var opacity;
    if(isDir)opacity=0.9;
    else if(connSet&&!inConn)opacity=0.08;
    else opacity=0.35;
    ctx.strokeStyle='rgba(0,0,0,'+opacity+')';
    ctx.lineWidth=isDir?1.5:0.8;
    ctx.beginPath();
    ctx.moveTo(pa.x,pa.y);
    ctx.lineTo(pb.x,pb.y);
    ctx.stroke();
  });
}

// ─── 节点：小圆点 ────────────────────────────────────
function drawNode(p,color,radius,isRoot,isSelected,isHover,isDimmed,isMatch){
  if(p.z<=0)return;
  var r=Math.max(1.5,radius*p.scale);
  if(r<1){r=1;}
  var alpha=isDimmed?0.2:1;

  var nodeColor=isSelected?SELECTED:color;

  if(isRoot){
    ctx.fillStyle=isSelected?'rgba(13,122,62,'+alpha+')':'rgba(0,0,0,'+alpha+')';
    ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle=isSelected?'rgba(13,122,62,'+(0.5*alpha)+')':'rgba(0,0,0,'+(0.3*alpha)+')';
    ctx.lineWidth=0.8;
    ctx.beginPath();ctx.arc(p.x,p.y,r+4,0,Math.PI*2);ctx.stroke();
  }else{
    ctx.fillStyle=isSelected?'rgba(13,122,62,'+(0.9*alpha)+')':'rgba(0,0,0,'+(0.7*alpha)+')';
    ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill();
  }

  // 选中：深绿色环
  if(isSelected){
    ctx.strokeStyle=SELECTED;
    ctx.lineWidth=1.2;
    ctx.beginPath();ctx.arc(p.x,p.y,r+5,0,Math.PI*2);ctx.stroke();
  }
  // 搜索匹配：蓝色细虚环
  if(isMatch&&!isSelected){
    ctx.strokeStyle='rgba(0,102,255,0.5)';
    ctx.lineWidth=0.8;
    ctx.setLineDash([2,2]);
    ctx.beginPath();ctx.arc(p.x,p.y,r+6,0,Math.PI*2);ctx.stroke();
    ctx.setLineDash([]);
  }
  // hover：浅环
  if(isHover&&!isSelected){
    ctx.strokeStyle='rgba(0,0,0,0.3)';
    ctx.lineWidth=0.8;
    ctx.beginPath();ctx.arc(p.x,p.y,r+3,0,Math.PI*2);ctx.stroke();
  }
}

function drawNodes(projMap,connSet){
  var vis=getVisible();
  var visAll=new Set();
  vis.entities.forEach(function(id){visAll.add(id)});
  vis.events.forEach(function(id){visAll.add(id)});
  var items=[];
  graphData.entities.forEach(function(ent){
    if(!vis.entities.has(ent.id))return;
    var p=projMap[ent.id];if(!p)return;
    items.push({type:'entity',data:ent,p:p});
  });
  graphData.events.forEach(function(ev){
    if(!vis.events.has(ev.id))return;
    var p=projMap[ev.id];if(!p)return;
    items.push({type:'event',data:ev,p:p});
  });
  items.sort(function(a,b){return b.p.z-a.p.z});
  for(var i=0;i<items.length;i++){
    var it=items[i];
    if(it.type==='entity'){
      var ent=it.data;
      var color=TYPE_COLORS[ent.type]||INK;
      var radius=ent.isRoot?6:3+Math.min(4,(ent.eventCount||0)*0.5);
      var isSel=selId===ent.id;
      var isHov=hoveredId===ent.id;
      var isDim=(connSet&&!connSet.has(ent.id))||(searchMatches&&!searchMatches.has(ent.id)&&ent.id!==selId);
      var isMatch=searchMatches&&searchMatches.has(ent.id);
      drawNode(it.p,color,radius,ent.isRoot,isSel,isHov,isDim,isMatch);
    }else{
      var ev=it.data;
      var isSel=selId===ev.id;
      var isHov=hoveredId===ev.id;
      var isDim=(connSet&&!connSet.has(ev.id))||(searchMatches&&!searchMatches.has(ev.id)&&ev.id!==selId);
      var isMatch=searchMatches&&searchMatches.has(ev.id);
      drawNode(it.p,EVENT,4,false,isSel,isHov,isDim,isMatch);
    }
  }
}

// ─── 标签：放大后才显示 ──────────────────────────────
var labelEls={};
function rebuildLabels(){
  labelsEl.innerHTML='';
  labelEls={};
  if(!graphData)return;
  var vis=getVisible();
  graphData.entities.forEach(function(ent){
    if(!vis.entities.has(ent.id))return;
    var el=document.createElement('div');
    el.className='label-3d'+(ent.isRoot?' root':'');
    el.textContent=ent.name;
    labelsEl.appendChild(el);
    labelEls[ent.id]=el;
  });
  graphData.events.forEach(function(ev){
    if(!vis.events.has(ev.id))return;
    var el=document.createElement('div');
    el.className='label-3d';
    el.textContent=ev.title;
    labelsEl.appendChild(el);
    labelEls[ev.id]=el;
  });
}

// 标签显示阈值：相机距离小于此值才显示标签
var LABEL_SHOW_DIST=1200;
function updateLabels(projMap,connSet){
  var showLabels=camDist<LABEL_SHOW_DIST;
  Object.keys(labelEls).forEach(function(id){
    var el=labelEls[id];
    var p=projMap[id];
    if(!p||p.z<=0||!showLabels){
      if(el._visible!==false){el.style.display='none';el._visible=false;}
      return;
    }
    if(el._visible===false){el.style.display='';el._visible=true;}
    var x=p.x|0,y=p.y|0;
    if(el._lx!==x||el._ly!==y){
      el.style.transform='translate3d('+x+'px,'+y+'px,0) translate(-50%,-50%)';
      el._lx=x;el._ly=y;
    }
    var cls='label-3d';
    if(selId===id)cls+=' selected';
    else if(hoveredId===id)cls+=' hover';
    else if(connSet&&!connSet.has(id))cls+=' dimmed';
    if(el._cls!==cls){el.className=cls;el._cls=cls;}
    // 距离越远越淡
    var op=Math.max(0.3,Math.min(1,LABEL_SHOW_DIST/p.z));
    if(cls.indexOf('selected')<0){
      if(el._op!==op){el.style.opacity=op;el._op=op;}
    }else if(el._op!==undefined){el.style.opacity='';el._op=undefined;}
  });
}

function computeProjMap(){
  var vis=getVisible();
  var visAll=new Set();
  vis.entities.forEach(function(id){visAll.add(id)});
  vis.events.forEach(function(id){visAll.add(id)});
  var map={allIds:visAll};
  visAll.forEach(function(id){
    var p=nodePositions[id];
    if(p)map[id]=project(p);
  });
  return map;
}

function computeConnSet(visAll){
  if(!selId)return null;
  var conn=new Set();conn.add(selId);
  graphData.edges.forEach(function(e){
    if(!visAll.has(e.entityId)||!visAll.has(e.eventId))return;
    if(e.entityId===selId||e.eventId===selId){conn.add(e.entityId);conn.add(e.eventId)}
  });
  return conn;
}

// ─── 交互 ────────────────────────────────────────────
var hoveredId=null;
var mouseDownPos={x:0,y:0};
var isDragging=false,isPanning=false;
var dragStart={x:0,y:0,rotX:0,rotY:0,panX:0,panY:0};
var velRotX=0,velRotY=0;
var lastMoveTime=0,lastMoveX=0,lastMoveY=0;
var inertiaRAF=null;
var focusAnim=null;

function startInertia(){
  function step(){
    if(Math.abs(velRotX)<0.0005&&Math.abs(velRotY)<0.0005){inertiaRAF=null;return}
    camRotY+=velRotY;
    camRotX=Math.max(-1.2,Math.min(1.2,camRotX+velRotX));
    velRotX*=0.94;velRotY*=0.94;
    markDirty();
    inertiaRAF=requestAnimationFrame(step);
  }
  inertiaRAF=requestAnimationFrame(step);
}

var tooltipEl=document.getElementById('tooltip');
function showTooltip(sx,sy,id){
  var data=nodeData.find(function(n){return n.id===id});
  if(!data)return;
  var html='';
  if(data.kind==='entity'){
    var e=eById[id];if(!e)return;
    html+='<div class="tt-name">'+esc(e.name)+'</div>';
    html+='<div class="tt-meta">'+esc(e.type)+' · '+(e.eventCount||0)+' '+M('kw_event')+'</div>';
  }else{
    var ev=evById[id];if(!ev)return;
    html+='<div class="tt-name">'+esc(ev.title)+'</div>';
    if(ev.category)html+='<div class="tt-meta">'+esc(ev.category)+'</div>';
    if(ev.summary)html+='<div class="tt-summary">'+esc(ev.summary)+'</div>';
  }
  tooltipEl.innerHTML=html;
  tooltipEl.style.display='block';
  var tw=tooltipEl.offsetWidth,th=tooltipEl.offsetHeight;
  var tx=sx+14,ty=sy+14;
  if(tx+tw>W-10)tx=sx-tw-14;
  if(ty+th>H-10)ty=sy-th-14;
  tooltipEl.style.left=tx+'px';
  tooltipEl.style.top=ty+'px';
}
function hideTooltip(){tooltipEl.style.display='none';}

function pickNode(sx,sy){
  var vis=getVisible();
  var visAll=new Set();
  vis.entities.forEach(function(id){visAll.add(id)});
  vis.events.forEach(function(id){visAll.add(id)});
  var best=null,bestDist=Infinity;
  visAll.forEach(function(id){
    var p=nodePositions[id];if(!p)return;
    var sp=project(p);
    if(sp.z<=0)return;
    var data=nodeData.find(function(n){return n.id===id});
    var r;
    if(data&&data.kind==='entity'){
      var ent=eById[id];
      r=ent.isRoot?5:2.5+Math.min(2.5,(ent.eventCount||0)*0.3);
    }else r=3;
    var screenR=Math.max(8,r*sp.scale*2);
    var dx=sx-sp.x,dy=sy-sp.y;
    var d=Math.sqrt(dx*dx+dy*dy);
    if(d<screenR&&d<bestDist){bestDist=d;best=id}
  });
  return best;
}

canvas.addEventListener('mousedown',function(e){
  stopAutoRotate();
  mouseDownPos={x:e.clientX,y:e.clientY};
  isDragging=false;
  dragStart={x:e.clientX,y:e.clientY,rotX:camRotX,rotY:camRotY,panX:camTargetX,panY:camTargetY};
  velRotX=0;velRotY=0;
  if(inertiaRAF){cancelAnimationFrame(inertiaRAF);inertiaRAF=null}
  lastMoveTime=performance.now();lastMoveX=e.clientX;lastMoveY=e.clientY;
  if(e.button===2){isPanning=true;canvas.style.cursor='grabbing';}
});

canvas.addEventListener('mousemove',function(e){
  if(e.buttons&1 && !isPanning){
    var dx=e.clientX-dragStart.x,dy=e.clientY-dragStart.y;
    if(dx*dx+dy*dy>16){isDragging=true;canvas.style.cursor='grabbing';}
    camRotY=dragStart.rotY+dx*0.005;
    camRotX=Math.max(-1.2,Math.min(1.2,dragStart.rotX+dy*0.005));
    var now=performance.now();
    var dt=Math.max(1,now-lastMoveTime);
    velRotY=(e.clientX-lastMoveX)/dt*0.005;
    velRotX=(e.clientY-lastMoveY)/dt*0.005;
    lastMoveTime=now;lastMoveX=e.clientX;lastMoveY=e.clientY;
    markDirty();
  }else if(isPanning){
    var pdx=e.clientX-dragStart.x,pdy=e.clientY-dragStart.y;
    var scale=fov/camDist;
    camTargetX=dragStart.panX - pdx*scale;
    camTargetY=dragStart.panY + pdy*scale;
    markDirty();
  }else{
    var id=pickNode(e.clientX,e.clientY);
    if(id!==hoveredId){hoveredId=id;canvas.style.cursor=id?'pointer':'grab';markDirty();}
    if(id)showTooltip(e.clientX,e.clientY,id);
    else hideTooltip();
  }
});

var clickTimer=null,dblClickGuard=false;
canvas.addEventListener('mouseup',function(e){
  if(isPanning){isPanning=false;canvas.style.cursor='grab';return;}
  if(isDragging){startInertia();canvas.style.cursor='grab';return;}
  if(dblClickGuard)return;
  var dx=e.clientX-mouseDownPos.x,dy=e.clientY-mouseDownPos.y;
  if(dx*dx+dy*dy>25)return;
  var id=pickNode(e.clientX,e.clientY);
  if(id){
    if(clickTimer){clearTimeout(clickTimer);clickTimer=null;return;}
    clickTimer=setTimeout(function(){
      clickTimer=null;
      var data=nodeData.find(function(n){return n.id===id});
      if(data){
        if(data.kind==='entity'&&!expEnt.has(id))expEnt.add(id);
        if(data.kind==='event'&&!expEv.has(id))expEv.add(id);
      }
      selId=id;navStack=[];
      focusOn(id);rebuildLabels();markDirty();
    },250);
  }else{
    selId=null;rebuildLabels();closeModal();markDirty();
  }
});

canvas.addEventListener('contextmenu',function(e){e.preventDefault();});
canvas.addEventListener('dblclick',function(e){
  e.preventDefault();
  if(clickTimer){clearTimeout(clickTimer);clickTimer=null;}
  dblClickGuard=true;
  setTimeout(function(){dblClickGuard=false;},300);
  var id=pickNode(e.clientX,e.clientY);
  if(id){
    var data=nodeData.find(function(n){return n.id===id});
    if(data){
      if(!expEnt.has(id)&&!expEv.has(id)){expEnt.add(id);}
      selId=id;navStack=[];
      focusOn(id);rebuildLabels();markDirty();
      showModal(id,data.kind);
    }
  }else{
    expEnt.clear();expEv.clear();selId=null;
    if(graphData)graphData.entities.forEach(function(en){expEnt.add(en.id)});
    closeModal();rebuildLabels();fitView();markDirty();
  }
});

canvas.addEventListener('wheel',function(e){
  stopAutoRotate();
  e.preventDefault();
  var factor=e.deltaY>0?1.12:0.89;
  var newDist=Math.max(100,Math.min(2500,camDist*factor));
  if(newDist===camDist)return;
  var mx=e.clientX,my=e.clientY;
  var scaleBefore=fov/camDist;
  var worldX=camTargetX + (mx-W/2)/scaleBefore;
  var worldY=camTargetY - (my-H/2)/scaleBefore;
  camDist=newDist;
  var scaleAfter=fov/camDist;
  camTargetX=worldX - (mx-W/2)/scaleAfter;
  camTargetY=worldY + (my-H/2)/scaleAfter;
  markDirty();
},{passive:false});

function focusOn(id){
  var p=nodePositions[id];if(!p)return;
  var modalOpen=document.getElementById('modal').classList.contains('open');
  var panOffset=modalOpen?Math.max(80,camDist*0.2):0;
  var endTx=p.x-panOffset,endTy=p.y,endTz=p.z;
  var startTx=camTargetX,startTy=camTargetY,startTz=camTargetZ;
  var startDist=camDist;
  var endDist=Math.max(200,Math.min(500,camDist*0.65));
  var startTime=performance.now();
  if(focusAnim)cancelAnimationFrame(focusAnim);
  function step(now){
    var t=Math.min(1,(now-startTime)/700);
    var e=t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;
    camTargetX=startTx+(endTx-startTx)*e;
    camTargetY=startTy+(endTy-startTy)*e;
    camTargetZ=startTz+(endTz-startTz)*e;
    camDist=startDist+(endDist-startDist)*e;
    markDirty();
    if(t<1)focusAnim=requestAnimationFrame(step);
  }
  focusAnim=requestAnimationFrame(step);
}

function fitView(){
  var vis=getVisible();
  var ids=[];
  vis.entities.forEach(function(id){ids.push(id)});
  vis.events.forEach(function(id){ids.push(id)});
  if(!ids.length){camTargetX=0;camTargetY=0;camTargetZ=0;camDist=700;markDirty();return}
  var x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity,z0=Infinity,z1=-Infinity;
  ids.forEach(function(id){var p=nodePositions[id];if(!p)return;if(p.x<x0)x0=p.x;if(p.x>x1)x1=p.x;if(p.y<y0)y0=p.y;if(p.y>y1)y1=p.y;if(p.z<z0)z0=p.z;if(p.z>z1)z1=p.z});
  var cx=(x0+x1)/2,cy=(y0+y1)/2,cz=(z0+z1)/2;
  var span=Math.max(x1-x0,y1-y0,z1-z0);
  var endTx=cx,endTy=cy,endTz=cz;
  var endDist=Math.max(span*1.6,350);
  var startTx=camTargetX,startTy=camTargetY,startTz=camTargetZ,startDist=camDist;
  var startRotX=camRotX,startRotY=camRotY;
  var endRotX=0.25,endRotY=0.4;
  var startTime=performance.now();
  if(focusAnim)cancelAnimationFrame(focusAnim);
  function step(now){
    var t=Math.min(1,(now-startTime)/800);
    var e=t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;
    camTargetX=startTx+(endTx-startTx)*e;
    camTargetY=startTy+(endTy-startTy)*e;
    camTargetZ=startTz+(endTz-startTz)*e;
    camDist=startDist+(endDist-startDist)*e;
    camRotX=startRotX+(endRotX-startRotX)*e;
    camRotY=startRotY+(endRotY-startRotY)*e;
    markDirty();
    if(t<1)focusAnim=requestAnimationFrame(step);
  }
  focusAnim=requestAnimationFrame(step);
}

var autoRotRAF=null;
function startAutoRotate(){
  var duration=5000,startTime=performance.now();
  var speed=0.008;
  function step(now){
    var elapsed=now-startTime;
    var t=Math.min(1,elapsed/duration);
    var fade=1-t;
    camRotY+=speed*fade;
    markDirty();
    if(t<1)autoRotRAF=requestAnimationFrame(step);
  }
  autoRotRAF=requestAnimationFrame(step);
}
function stopAutoRotate(){if(autoRotRAF){cancelAnimationFrame(autoRotRAF);autoRotRAF=null;}}

// ─── 模态详情 ────────────────────────────────────────
function showModal(id,kind,pushNav){
  if(pushNav!==false)navStack.push({id:id,kind:kind});
  var modal=document.getElementById('modal');
  var mask=document.getElementById('modal-mask');
  var body=document.getElementById('modal-body');
  var html='';
  if(navStack.length>1)html+='<button class="back-btn" id="btn-back">← '+M('kw_back')+'</button>';
  if(kind==='entity'){
    var e=eById[id];
    html+='<div class="type-tag">'+esc(e.type)+'</div>';
    html+='<h3>'+esc(e.name)+'</h3>';
    if(e.description)html+='<div class="field"><div class="label">'+M('kw_detail_description')+'</div><div class="value">'+esc(e.description)+'</div></div>';
    html+='<div class="field"><div class="label">'+M('kw_detail_related')+'</div><div class="value">'+(e.eventCount||0)+'</div></div>';
    var ce=evByEnt[id]||[];
    if(ce.length){html+='<div class="divider"></div><div class="field"><div class="label">'+M('kw_event')+'</div>';ce.forEach(function(eid){var ev=evById[eid];if(ev)html+='<div class="conn-item" data-id="'+eid+'" data-kind="event"><span>'+esc(ev.title)+'</span></div>'});html+='</div>'}
  }else{
    var ev=evById[id];
    html+='<div class="type-tag event">EVENT</div>';
    html+='<h3>'+esc(ev.title)+'</h3>';
    if(ev.summary)html+='<div class="field"><div class="label">'+M('kw_detail_description')+'</div><div class="value">'+esc(ev.summary)+'</div></div>';
    if(ev.category)html+='<div class="field"><div class="label">'+M('kw_detail_category')+'</div><div class="value">'+esc(ev.category)+'</div></div>';
    if(ev.keywords&&ev.keywords.length)html+='<div class="field"><div class="label">'+M('kw_detail_keywords')+'</div><div class="value">'+ev.keywords.map(esc).join(' · ')+'</div></div>';
    var ce2=entByEv[id]||[];
    if(ce2.length){html+='<div class="divider"></div><div class="field"><div class="label">'+M('kw_detail_related')+'</div>';ce2.forEach(function(eid){var e=eById[eid];if(e)html+='<div class="conn-item" data-id="'+eid+'" data-kind="entity"><span>'+esc(e.name)+'</span><span class="badge">'+esc(e.type)+'</span></div>'});html+='</div>'}
  }
  body.innerHTML=html;
  modal.classList.add('open');mask.classList.add('open');
  body.querySelectorAll('.conn-item').forEach(function(el){el.setAttribute('tabindex','0')});
  var backBtn=document.getElementById('btn-back');
  if(backBtn)backBtn.addEventListener('click',function(){
    navStack.pop();
    var prev=navStack[navStack.length-1];
    if(prev){selId=prev.id;focusOn(prev.id);rebuildLabels();showModal(prev.id,prev.kind,false)}
    else closeModal();
  });
  body.querySelectorAll('.conn-item').forEach(function(el){
    el.addEventListener('click',function(){
      var nid=el.getAttribute('data-id'),nk=el.getAttribute('data-kind');
      if(nk==='entity'&&!expEnt.has(nid))expEnt.add(nid);
      if(nk==='event'&&!expEv.has(nid))expEv.add(nid);
      selId=nid;focusOn(nid);rebuildLabels();showModal(nid,nk);
    });
    el.addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();el.click();}});
  });
}
function closeModal(){
  document.getElementById('modal').classList.remove('open');
  document.getElementById('modal-mask').classList.remove('open');
  navStack=[];
}
function esc(s){if(!s)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

document.getElementById('btn-reset').onclick=function(){
  expEnt.clear();expEv.clear();selId=null;
  if(graphData)graphData.entities.forEach(function(e){expEnt.add(e.id)});
  closeModal();rebuildLabels();fitView();markDirty();
};
document.getElementById('btn-expand').onclick=function(){
  if(graphData){
    graphData.entities.forEach(function(e){expEnt.add(e.id)});
    graphData.events.forEach(function(e){expEv.add(e.id)});
  }
  selId=null;closeModal();rebuildLabels();fitView();markDirty();
};
document.getElementById('btn-close').onclick=closeModal;
document.getElementById('modal-mask').addEventListener('click',closeModal);

// 键盘
function getRelatedIds(id){
  var related=new Set();if(!id||!graphData)return related;
  graphData.edges.forEach(function(e){
    if(e.entityId===id)related.add(e.eventId);
    else if(e.eventId===id)related.add(e.entityId);
  });
  return related;
}
function navigateRelated(direction){
  if(!selId)return;
  var related=Array.from(getRelatedIds(selId));
  if(!related.length)return;
  var vis=getVisible();
  related=related.filter(function(id){return vis.entities.has(id)||vis.events.has(id)});
  if(!related.length)return;
  var curP=nodePositions[selId];
  related.sort(function(a,b){
    var pa=nodePositions[a],pb=nodePositions[b];
    if(!pa||!pb)return 0;
    var da=Math.hypot(pa.x-curP.x,pa.y-curP.y,pa.z-curP.z);
    var db=Math.hypot(pb.x-curP.x,pb.y-curP.y,pb.z-curP.z);
    return direction==='next'?da-db:db-da;
  });
  var nextId=related[0];
  var data=nodeData.find(function(n){return n.id===nextId});
  if(data){
    if(data.kind==='entity'&&!expEnt.has(nextId))expEnt.add(nextId);
    if(data.kind==='event'&&!expEv.has(nextId))expEv.add(nextId);
    selId=nextId;navStack=[];focusOn(nextId);rebuildLabels();showModal(nextId,data.kind);
  }
}
window.addEventListener('keydown',function(e){
  if(document.activeElement&&document.activeElement.tagName==='INPUT')return;
  if(e.key==='Escape'){
    if(document.getElementById('modal').classList.contains('open'))closeModal();
    else{selId=null;rebuildLabels()}
    markDirty();
  }else if(e.key===' '){
    e.preventDefault();
    expEnt.clear();expEv.clear();selId=null;
    if(graphData)graphData.entities.forEach(function(en){expEnt.add(en.id)});
    closeModal();rebuildLabels();fitView();markDirty();
  }else if(e.key==='ArrowRight'||e.key==='ArrowDown'){e.preventDefault();navigateRelated('next');}
  else if(e.key==='ArrowLeft'||e.key==='ArrowUp'){e.preventDefault();navigateRelated('prev');}
});

// 搜索
var searchInput=document.getElementById('search-input');
var searchQuery='',searchMatches=null;
searchInput.addEventListener('input',function(){
  searchQuery=searchInput.value.trim().toLowerCase();
  if(!searchQuery){searchMatches=null;rebuildLabels();markDirty();return}
  searchMatches=new Set();
  var firstMatch=null;
  if(graphData){
    graphData.entities.forEach(function(en){
      if(en.name.toLowerCase().indexOf(searchQuery)>=0||(en.type||'').toLowerCase().indexOf(searchQuery)>=0){
        searchMatches.add(en.id);if(!firstMatch)firstMatch=en.id;
      }
    });
    graphData.events.forEach(function(ev){
      if(ev.title.toLowerCase().indexOf(searchQuery)>=0||(ev.category||'').toLowerCase().indexOf(searchQuery)>=0||(ev.summary||'').toLowerCase().indexOf(searchQuery)>=0){
        searchMatches.add(ev.id);if(!firstMatch)firstMatch=ev.id;
      }
    });
  }
  rebuildLabels();
  if(firstMatch){
    expEnt.clear();expEv.clear();
    searchMatches.forEach(function(id){
      var data=nodeData.find(function(n){return n.id===id});
      if(!data)return;
      if(data.kind==='entity'){
        expEnt.add(id);
        (evByEnt[id]||[]).forEach(function(vid){expEv.add(vid);(entByEv[vid]||[]).forEach(function(eid){expEnt.add(eid)})});
      }else{
        expEv.add(id);
        (entByEv[id]||[]).forEach(function(eid){expEnt.add(eid);(evByEnt[eid]||[]).forEach(function(vid){expEv.add(vid)})});
      }
    });
    selId=firstMatch;focusOn(firstMatch);rebuildLabels();
  }
  markDirty();
});
searchInput.addEventListener('keydown',function(e){
  if(e.key==='Escape'){searchInput.value='';searchQuery='';searchMatches=null;rebuildLabels();searchInput.blur();markDirty();}
  else if(e.key==='Enter'&&searchMatches&&searchMatches.size>0){
    var first=Array.from(searchMatches)[0];
    var data=nodeData.find(function(n){return n.id===first});
    if(data){selId=first;navStack=[];focusOn(first);showModal(first,data.kind);}
    searchInput.blur();
  }
});

// ─── Minimap ─────────────────────────────────────────
var miniCanvas=document.getElementById('minimap-canvas');
var miniCtx=miniCanvas.getContext('2d');
var miniSize=132;
miniCanvas.width=miniSize*DPR;miniCanvas.height=miniSize*DPR;
miniCanvas.style.width=miniSize+'px';miniCanvas.style.height=miniSize+'px';
miniCtx.setTransform(DPR,0,0,DPR,0,0);
var miniBounds={minX:-300,maxX:300,minY:-300,maxY:300};
function updateMiniBounds(){
  if(!graphData||!nodePositions)return;
  var x0=Infinity,x1=-Infinity,z0=Infinity,z1=-Infinity;
  Object.keys(nodePositions).forEach(function(id){
    var p=nodePositions[id];
    if(p.x<x0)x0=p.x;if(p.x>x1)x1=p.x;
    if(p.z<z0)z0=p.z;if(p.z>z1)z1=p.z;
  });
  if(x0===Infinity)return;
  var pad=50;
  miniBounds={minX:x0-pad,maxX:x1+pad,minY:z0-pad,maxY:z1+pad};
}
function drawMinimap(){
  miniCtx.clearRect(0,0,miniSize,miniSize);
  if(!graphData)return;
  updateMiniBounds();
  var b=miniBounds;
  var sx=miniSize/(b.maxX-b.minX),sy=miniSize/(b.maxY-b.minY);
  var s=Math.min(sx,sy);
  var ox=(b.minX+b.maxX)/2,oy=(b.minY+b.maxY)/2;
  // 视角框
  var viewHalf=camDist*0.5;
  var vx=(camTargetX-ox)*s+miniSize/2;
  var vy=(camTargetZ-oy)*s+miniSize/2;
  var vw=viewHalf*s*2,vh=viewHalf*s*2;
  miniCtx.strokeStyle='rgba(0,102,255,0.4)';
  miniCtx.lineWidth=1;
  miniCtx.strokeRect(vx-vw/2,vy-vh/2,vw,vh);
  var vis=getVisible();
  graphData.entities.forEach(function(en){
    if(!vis.entities.has(en.id))return;
    var p=nodePositions[en.id];if(!p)return;
    var mx=(p.x-ox)*s+miniSize/2,my=(p.z-oy)*s+miniSize/2;
    if(selId===en.id){miniCtx.fillStyle=ACCENT;miniCtx.beginPath();miniCtx.arc(mx,my,2.5,0,Math.PI*2);miniCtx.fill();}
    else{miniCtx.fillStyle='rgba(0,0,0,0.5)';miniCtx.beginPath();miniCtx.arc(mx,my,en.isRoot?1.8:1.2,0,Math.PI*2);miniCtx.fill();}
  });
  graphData.events.forEach(function(ev){
    if(!vis.events.has(ev.id))return;
    var p=nodePositions[ev.id];if(!p)return;
    var mx=(p.x-ox)*s+miniSize/2,my=(p.z-oy)*s+miniSize/2;
    miniCtx.fillStyle='rgba(147,51,234,0.4)';
    miniCtx.beginPath();miniCtx.arc(mx,my,1,0,Math.PI*2);miniCtx.fill();
  });
}
miniCanvas.addEventListener('click',function(e){
  if(!graphData)return;
  var rect=miniCanvas.getBoundingClientRect();
  var mx=e.clientX-rect.left,my=e.clientY-rect.top;
  updateMiniBounds();
  var b=miniBounds;
  var sx=miniSize/(b.maxX-b.minX),sy=miniSize/(b.maxY-b.minY);
  var s=Math.min(sx,sy);
  var ox=(b.minX+b.maxX)/2,oy=(b.minY+b.maxY)/2;
  var worldX=(mx-miniSize/2)/s+ox;
  var worldZ=(my-miniSize/2)/s+oy;
  var startTx=camTargetX,startTz=camTargetZ;
  var startTime=performance.now();
  if(focusAnim)cancelAnimationFrame(focusAnim);
  function step(now){
    var t=Math.min(1,(now-startTime)/500);
    var e=t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;
    camTargetX=startTx+(worldX-startTx)*e;
    camTargetZ=startTz+(worldZ-startTz)*e;
    markDirty();
    if(t<1)focusAnim=requestAnimationFrame(step);
  }
  focusAnim=requestAnimationFrame(step);
});

// ─── 主渲染循环 ──────────────────────────────────────
var dirty=true;
function markDirty(){dirty=true}
function animate(){
  requestAnimationFrame(animate);
  if(!graphData)return;
  if(!dirty)return;
  dirty=false;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='#fafafa';
  ctx.fillRect(0,0,W,H);
  drawNebulae();
  var projMap=computeProjMap();
  var connSet=computeConnSet(projMap.allIds);
  drawEdges(projMap,connSet);
  drawNodes(projMap,connSet);
  updateLabels(projMap,connSet);
  drawMinimap();
}

// 超时兜底
setTimeout(function(){
  if(document.getElementById('loading').style.display!=='none'){
    document.getElementById('loading').style.display='none';
    errorMsg.style.display='block';
    errorMsg.innerHTML='<div style="font-size:14px;font-weight:600;margin-bottom:8px;">'+M('kw_loading')+'</div><div style="color:#666;font-size:12px;">'+M('kw_loading_timeout')+'</div>';
  }
},8000);

fetch('/api/graph').then(function(r){return r.json()}).then(function(data){
  graphData=data;
  document.getElementById('stat-ent').textContent=data.entities.length;
  document.getElementById('stat-evt').textContent=data.events.length;
  document.getElementById('stat-edg').textContent=data.edges.length;
  document.getElementById('loading').style.display='none';
  data.entities.sort(function(a,b){return(b.eventCount||0)-(a.eventCount||0)||a.name.localeCompare(b.name)});
  data.events.sort(function(a,b){return(a.rank||0)-(b.rank||0)||a.title.localeCompare(b.title)});
  data.entities.forEach(function(e){eById[e.id]=e});
  data.events.forEach(function(e){evById[e.id]=e});
  data.edges.forEach(function(e){
    if(!evByEnt[e.entityId])evByEnt[e.entityId]=[];
    evByEnt[e.entityId].push(e.eventId);
    if(!entByEv[e.eventId])entByEv[e.eventId]=[];
    entByEv[e.eventId].push(e.entityId);
  });
  data.entities.forEach(function(e){expEnt.add(e.id)});
  nodeData=[];
  data.entities.forEach(function(e,idx){
    var isRoot=idx===0;
    nodeData.push({id:e.id,kind:'entity',isRoot:isRoot});
    var theta=Math.random()*Math.PI*2;
    var phi=Math.acos(2*Math.random()-1);
    var r=isRoot?0:150+Math.random()*100;
    nodePositions[e.id]={x:r*Math.sin(phi)*Math.cos(theta),y:r*Math.sin(phi)*Math.sin(theta),z:r*Math.cos(phi),vx:0,vy:0,vz:0};
  });
  data.events.forEach(function(ev){
    nodeData.push({id:ev.id,kind:'event',isRoot:false});
    var theta=Math.random()*Math.PI*2;
    var phi=Math.acos(2*Math.random()-1);
    var r=100+Math.random()*150;
    nodePositions[ev.id]={x:r*Math.sin(phi)*Math.cos(theta),y:r*Math.sin(phi)*Math.sin(theta),z:r*Math.cos(phi),vx:0,vy:0,vz:0};
  });
  forceLayout3D();
  buildNebulae();
  rebuildLabels();
  fitView();
  animate();
  startAutoRotate();
  new EventSource('/api/heartbeat');
}).catch(function(err){
  document.getElementById('loading').style.display='none';
  errorMsg.style.display='block';
  errorMsg.innerHTML='<div style="font-size:14px;font-weight:600;margin-bottom:8px;">'+M('kw_no_data')+'</div><div style="color:#666;font-size:12px;margin-bottom:12px;">'+esc(err.message)+'</div><div style="color:#999;font-size:11px;">'+M('kw_no_data_hint')+'</div>';
});

applyLang();
document.getElementById('btn-lang').addEventListener('click',toggleLang);

})();
</script>
</body>
</html>`;

// ─── Server ─────────────────────────────────────────────────────────

async function serveGraphJSON(store: KnowledgeStore, res: ServerResponse): Promise<void> {
  try {
    const [entities, events, edges, sources] = await Promise.all([
      store.listEntities(),
      store.listEvents(),
      store.listEventEntities(),
      store.listSources(),
    ]);

    const eventEntityMap = new Map<string, string[]>();
    for (const edge of edges) {
      const list = eventEntityMap.get(edge.eventId) ?? [];
      list.push(edge.entityId);
      eventEntityMap.set(edge.eventId, list);
    }

    const data = {
      entities: entities.map(({ id, sourceId, type, name, normalizedName, eventCount, description }) => ({
        id, sourceId, type, name, normalizedName, eventCount, description,
      })),
      events: events.map(({ id, sourceId, documentId, title, rank, summary, category, keywords }) => ({
        id, sourceId, documentId, title, rank, summary, category, keywords,
        entityIds: eventEntityMap.get(id) ?? [],
      })),
      edges,
      sources: sources.map(({ id, name }) => ({ id, name })),
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(error) }));
  }
}

function serveHTML(res: ServerResponse, locale: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  const dictJson = JSON.stringify({
    zh: {
      kw_title:'知识图谱',kw_entity:'实体 ',kw_event:'事件 ',kw_relation:'关系 ',
      kw_search_placeholder:'搜索节点…',kw_btn_reset:'重置',kw_btn_expand:'展开',
      kw_hint_drag:'拖拽平移 · 滚轮缩放 · 单击展开 · 双击查看详情',
      kw_loading:'加载中…',kw_back:'返回',kw_detail_related:'关联',
      kw_detail_description:'描述',kw_detail_category:'分类',kw_detail_keywords:'关键词',
      kw_loading_timeout:'加载超时',kw_no_data:'暂无数据',kw_no_data_hint:'请先用 /knowledge 导入文档',
      kw_lang_toggle:'English',
    },
    en: {
      kw_title:'Knowledge Graph',kw_entity:'Entities ',kw_event:'Events ',kw_relation:'Relations ',
      kw_search_placeholder:'Search nodes…',kw_btn_reset:'Reset',kw_btn_expand:'Expand',
      kw_hint_drag:'Drag to pan · Scroll to zoom · Click to expand · Double-click for details',
      kw_loading:'Loading…',kw_back:'Back',kw_detail_related:'Related',
      kw_detail_description:'Description',kw_detail_category:'Category',kw_detail_keywords:'Keywords',
      kw_loading_timeout:'Loading timed out',kw_no_data:'No data',kw_no_data_hint:'Please ingest documents with /knowledge first',
      kw_lang_toggle:'中文',
    },
  });
  const injected = HTML.replace('__DICT_INJECT__', dictJson).replace('__LOCALE_INJECT__', locale);
  res.end(injected);
}

// ─── Public API ─────────────────────────────────────────────────────

export async function handleWeb(host: SlashCommandHost): Promise<void> {
  const store = await getKnowledgeStore();
  const s = await store.stats();
  if (s.entities === 0 && s.events === 0) {
    throw new Error(t('knowledge.empty_store'));
  }

  const server = createServer((req, res) => {
    if (req.url === '/api/graph') {
      void serveGraphJSON(store, res);
      return;
    }
    if (req.url === '/api/heartbeat') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      const timer = setInterval(() => { res.write(': ping\n\n'); }, 15_000);
      res.on('close', () => {
        clearInterval(timer);
        server.close();
      });
      res.write(': ok\n\n');
      return;
    }
    serveHTML(res, getLocale());
  });
  registerServer(server);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  openUrl(url);
  host.showStatus(t('knowledge.web_opened', { url }));
}
