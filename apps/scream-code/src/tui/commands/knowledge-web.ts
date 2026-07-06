/**
 * /knowledge web — start a local HTTP server and open the browser
 * to display an interactive Cytoscape.js knowledge graph visualization.
 */

import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { KnowledgeStore } from '@scream-code/knowledge';

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

// Close all knowledge web servers when the scream-code process exits.
process.on('exit', closeAllServers);

// ─── HTML template ──────────────────────────────────────────────────

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scream 知识图谱</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:#fff;color:#18181b}
#container{width:100%;height:100%;position:relative;overflow:hidden}
svg{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1}
.node{position:absolute;border-radius:10px;display:flex;align-items:center;justify-content:center;text-align:center;cursor:pointer;z-index:2;user-select:none;transition:opacity .25s,box-shadow .25s,border-color .25s;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:0 14px;font-size:12px;line-height:1.3;animation:float 6s ease-in-out infinite}
.node.entity{background:#fff;border:1.5px solid #d4d4d8;font-weight:600;color:#1a1a1a;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.node.entity.root{border:2px solid #15803d;background:#f0fdf4;box-shadow:0 4px 20px rgba(21,128,61,.15);font-size:14px}
.node.entity.expanded{border-color:#15803d;box-shadow:0 2px 12px rgba(21,128,61,.1)}
.node.event{background:#fafafa;border:1px solid #e5e7eb;font-weight:500;color:#525252;box-shadow:0 1px 4px rgba(0,0,0,.04);border-radius:8px}
.node.event.expanded{border-color:#22c55e;background:#f8fef9;box-shadow:0 2px 8px rgba(21,128,61,.08)}
.node.selected{border-color:#15803d !important;background:#f0fdf4 !important;box-shadow:0 0 0 3px rgba(21,128,61,.12),0 4px 16px rgba(21,128,61,.14) !important}
.node.dimmed{opacity:.12;filter:grayscale(.6)}
.node:hover{box-shadow:0 4px 16px rgba(0,0,0,.08) !important}
.edge{stroke:#b0b0b0;stroke-width:.8;fill:none;opacity:.6}
.edge.animated{stroke:#999;stroke-width:1;stroke-dasharray:6 4;animation:dash 1.2s linear infinite;opacity:.45}
.edge.dimmed{stroke:#e0e0e0;stroke-width:.4;opacity:.06}
.edge.highlighted{stroke:#15803d;stroke-width:1.8;opacity:1}
@keyframes dash{to{stroke-dashoffset:-10}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
#toolbar{position:absolute;left:16px;top:16px;z-index:10;display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:8px 18px;box-shadow:0 2px 8px rgba(0,0,0,.04)}
#toolbar button{background:#fff;color:#525252;border:1px solid #d4d4d8;padding:5px 16px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:500;transition:all .15s}
#toolbar button:hover{background:#f0fdf4;border-color:#15803d;color:#15803d}
#toolbar .sep{width:1px;height:16px;background:#e5e7eb}
#toolbar .chip{color:#a1a1aa;font-size:11px;letter-spacing:.3px}
#toolbar .chip b{color:#15803d;font-size:13px;font-weight:700;margin-left:4px}
#hint{position:absolute;left:16px;bottom:16px;z-index:10;color:#c4c4c4;font-size:11px;letter-spacing:.2px}
#detail{position:fixed;right:0;top:0;width:380px;height:100vh;background:#fff;border-left:1px solid #e5e7eb;transform:translateX(100%);transition:transform .3s cubic-bezier(.4,0,.2,1);z-index:20;overflow-y:auto;padding:32px 28px;box-shadow:-4px 0 24px rgba(0,0,0,.04)}
#detail.open{transform:translateX(0)}
#detail h3{font-size:17px;font-weight:700;color:#18181b;margin-bottom:20px;padding-right:32px;line-height:1.4}
#detail .field{margin-bottom:18px}
#detail .field .label{font-size:10px;color:#15803d;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:5px}
#detail .field .value{font-size:13px;color:#525252;line-height:1.6}
#detail .close{position:absolute;top:20px;right:20px;background:none;border:none;color:#c4c4c4;cursor:pointer;font-size:18px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:8px;transition:all .15s}
#detail .close:hover{color:#18181b;background:#f4f4f5}
#detail .conn-item{font-size:13px;color:#15803d;cursor:pointer;padding:7px 10px;border-radius:8px;transition:all .15s;border:1px solid transparent}
#detail .conn-item:hover{background:#f0fdf4;border-color:#bbf7d0}
#detail .badge{font-size:10px;color:#15803d;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:5px;padding:1px 7px;margin-left:8px;font-weight:500}
#detail .back-btn{display:inline-flex;align-items:center;gap:5px;background:none;border:1px solid #d4d4d8;color:#525252;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:500;margin-bottom:16px;transition:all .15s}
#detail .back-btn:hover{background:#f0fdf4;border-color:#15803d;color:#15803d}
#detail .type-tag{display:inline-block;font-size:10px;color:#15803d;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:5px;padding:2px 10px;font-weight:600;margin-bottom:16px;letter-spacing:.3px}
#detail .divider{height:1px;background:#f0f0f0;margin:18px 0}
#loading{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:30;color:#15803d;font-size:14px;font-weight:500;display:flex;align-items:center;gap:8px}
#loading .dot{width:6px;height:6px;background:#15803d;border-radius:50%;animation:blink 1.2s ease-in-out infinite}
#loading .dot:nth-child(2){animation-delay:.2s}
#loading .dot:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}
</style>
</head>
<body>
<div id="container"><svg id="edges-svg"></svg></div>
<div id="toolbar">
  <span class="chip">实体<b id="stat-ent">0</b></span>
  <span class="chip">事件<b id="stat-evt">0</b></span>
  <span class="chip">关系<b id="stat-edg">0</b></span>
  <span class="sep"></span>
  <button id="btn-reset">重置</button>
  <button id="btn-expand">展开全部</button>
</div>
<div id="hint">单击展开/收起 · 双击查看详情 · 滚轮缩放 · 拖拽平移</div>
<div id="detail"><button class="close" id="btn-close">&times;</button><div id="detail-body"></div></div>
<div id="loading"><span class="dot"></span><span class="dot"></span><span class="dot"></span>加载知识图谱...</div>
<script>
(function(){
  var graphData;
  var container = document.getElementById('container');
  var svg = document.getElementById('edges-svg');

  // camera
  var cam = {x:0,y:0,zoom:1};
  var W=window.innerWidth, H=window.innerHeight;

  function w2s(wx,wy){return{x:(wx-cam.x)*cam.zoom+W/2,y:(wy-cam.y)*cam.zoom+H/2}}
  function s2w(sx,sy){return{x:(sx-W/2)/cam.zoom+cam.x,y:(sy-H/2)/cam.zoom+cam.y}}

  // pan & zoom
  var drag=false,moved=false,dragX,dragY;
  container.addEventListener('mousedown',function(e){if(e.target!==container&&e.target!==svg)return;drag=true;moved=false;dragX=e.clientX;dragY=e.clientY});
  window.addEventListener('mousemove',function(e){if(!drag)return;var dx=e.clientX-dragX,dy=e.clientY-dragY;if(Math.abs(dx)>2||Math.abs(dy)>2)moved=true;cam.x-=dx/cam.zoom;cam.y-=dy/cam.zoom;dragX=e.clientX;dragY=e.clientY;render()});
  window.addEventListener('mouseup',function(){drag=false});
  container.addEventListener('wheel',function(e){e.preventDefault();var pt=s2w(e.clientX,e.clientY);var f=e.deltaY<0?1.12:1/1.12;cam.zoom=Math.max(.15,Math.min(4,cam.zoom*f));cam.x=pt.x-(e.clientX-W/2)/cam.zoom;cam.y=pt.y-(e.clientY-H/2)/cam.zoom;render()},{passive:false});
  window.addEventListener('resize',function(){W=window.innerWidth;H=window.innerHeight;render()});

  // layout constants (SAG)
  var EW=160,EH=40,EVW=170,EVH=40;
  var ER_START=220,ER_GAP=190,ER_SLOT=200;
  var VR_START=500,VR_GAP=180,VR_SLOT=220;
  var ROOT_LIMIT=8;
  var GA=Math.PI*(3-Math.sqrt(5));

  // state
  var eById={},evById={};
  var evByEnt={},entByEv={};
  var expEnt=new Set(),expEv=new Set();
  var selId=null;
  var pos={};
  var navStack=[];

  // node/edge DOM elements
  var nodeEls={},edgeEls=[];

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

    // default: show all entities, no events expanded
    graphData.entities.forEach(function(e){expEnt.add(e.id)});

    buildPositions();
    fitView();
    rebuildDOM();
  });

  function buildPositions(){
    pos={};
    var root=graphData.entities[0];
    if(root)pos[root.id]={x:-EW/2,y:-EH/2,root:true};
    var sec=graphData.entities.slice(1);
    placeRings(sec.map(function(e){return e.id}),ER_START,ER_GAP,ER_SLOT,EW,EH,-Math.PI/2);
    placeEvents(graphData.events,-Math.PI/2+Math.PI/12);
  }

  function placeRings(ids,sr,gap,slot,nw,nh,aoff){
    var idx=0,ring=0;
    while(idx<ids.length){
      var r=sr+ring*gap;
      var cap=Math.max(6,Math.floor(2*Math.PI*r/slot));
      for(var s=0;s<cap&&idx<ids.length;s++){
        var a=aoff+(2*Math.PI*s)/cap;
        pos[ids[idx]]={x:Math.cos(a)*r-nw/2,y:Math.sin(a)*r-nh/2};
        idx++;
      }
      ring++;
    }
  }

  function placeEvents(events,aoff){
    var occ={};
    for(var i=0;i<events.length;i++){
      var da=i*GA;
      var sl=findSlot(da,aoff,occ);
      var r=VR_START+sl.ring*VR_GAP;
      var a=aoff+(2*Math.PI*sl.idx)/sl.cap;
      pos[events[i].id]={x:Math.cos(a)*r-EVW/2,y:Math.sin(a)*r-EVH/2};
    }
  }

  function findSlot(da,aoff,occ){
    var ring=0;
    while(true){
      var r=VR_START+ring*VR_GAP;
      var cap=Math.max(8,Math.floor(2*Math.PI*r/VR_SLOT));
      var o=occ[ring]||{};
      var ds=((Math.round(((da-aoff)/(2*Math.PI))*cap)%cap)+cap)%cap;
      var f=nearFree(ds,cap,o);
      if(f!=null){o[f]=true;occ[ring]=o;return{ring:ring,idx:f,cap:cap}}
      ring++;
    }
  }

  function nearFree(d,cap,o){
    for(var i=0;i<cap;i++){
      var cs=i===0?[d]:[((d-i)%cap+cap)%cap,((d+i)%cap+cap)%cap];
      for(var j=0;j<cs.length;j++)if(!o[cs[j]])return cs[j];
    }
    return null;
  }

  function fitView(){
    var vis=getVisible();
    var ids=[];
    vis.entities.forEach(function(id){ids.push(id)});
    vis.events.forEach(function(id){ids.push(id)});
    if(!ids.length){cam.x=0;cam.y=0;cam.zoom=1;return}
    var x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
    ids.forEach(function(id){var p=pos[id];if(!p)return;var w=eById[id]?EW:EVW,h=eById[id]?EH:EVH;if(p.x<x0)x0=p.x;if(p.x+w>x1)x1=p.x+w;if(p.y<y0)y0=p.y;if(p.y+h>y1)y1=p.y+h});
    cam.x=(x0+x1)/2;cam.y=(y0+y1)/2;
    cam.zoom=Math.min((W-120)/(x1-x0),(H-120)/(y1-y0),1.2);
  }

  function getVisible(){
    var ve=new Set(),vv=new Set();
    graphData.entities.slice(0,ROOT_LIMIT).forEach(function(e){ve.add(e.id)});
    expEnt.forEach(function(eid){ve.add(eid);(evByEnt[eid]||[]).forEach(function(v){vv.add(v)})});
    expEv.forEach(function(eid){vv.add(eid);(entByEv[eid]||[]).forEach(function(e){ve.add(e)})});
    return{entities:ve,events:vv};
  }

  function rebuildDOM(){
    // clear old
    Object.keys(nodeEls).forEach(function(id){if(nodeEls[id].parentNode)nodeEls[id].parentNode.removeChild(nodeEls[id])});
    while(svg.firstChild)svg.removeChild(svg.firstChild);
    nodeEls={};edgeEls=[];

    var vis=getVisible();
    var visAll=new Set();vis.entities.forEach(function(id){visAll.add(id)});vis.events.forEach(function(id){visAll.add(id)});

    // connection set for highlighting
    var conn=null;
    if(selId){
      conn=new Set();conn.add(selId);
      graphData.edges.forEach(function(e){
        if(!visAll.has(e.entityId)||!visAll.has(e.eventId))return;
        if(e.entityId===selId||e.eventId===selId){conn.add(e.entityId);conn.add(e.eventId)}
      });
    }

    // edges
    graphData.edges.forEach(function(e){
      if(!visAll.has(e.entityId)||!visAll.has(e.eventId))return;
      var line=document.createElementNS('http://www.w3.org/2000/svg','line');
      var isDir=selId&&(e.entityId===selId||e.eventId===selId);
      var isRel=conn&&conn.has(e.entityId)&&conn.has(e.eventId);
      var isExp=expEnt.has(e.entityId)||expEv.has(e.eventId);
      if(isDir)line.setAttribute('class','edge highlighted');
      else if(isRel)line.setAttribute('class','edge');
      else if(conn)line.setAttribute('class','edge dimmed');
      else line.setAttribute('class',isExp?'edge animated':'edge');
      line.setAttribute('data-src',e.entityId);
      line.setAttribute('data-tgt',e.eventId);
      svg.appendChild(line);
      edgeEls.push(line);
    });

    // nodes
    graphData.entities.forEach(function(ent){
      if(!vis.entities.has(ent.id))return;
      var el=mkNode(ent.id,ent.name,'entity',pos[ent.id].root,expEnt.has(ent.id));
      container.appendChild(el);nodeEls[ent.id]=el;
    });
    graphData.events.forEach(function(ev){
      if(!vis.events.has(ev.id))return;
      var el=mkNode(ev.id,ev.title,'event',false,expEv.has(ev.id));
      container.appendChild(el);nodeEls[ev.id]=el;
    });

    // apply dimming
    if(conn){
      Object.keys(nodeEls).forEach(function(id){
        if(conn.has(id))nodeEls[id].classList.remove('dimmed');
        else nodeEls[id].classList.add('dimmed');
      });
      if(selId&&nodeEls[selId])nodeEls[selId].classList.add('selected');
    }

    render();
  }

  function mkNode(id,label,kind,root,expanded){
    var el=document.createElement('div');
    el.className='node '+kind;
    if(root)el.classList.add('root');
    if(expanded)el.classList.add('expanded');
    el.textContent=label;
    el.setAttribute('data-id',id);
    el.setAttribute('data-kind',kind);
    var dur=5+Math.random()*4;
    var del=Math.random()*dur;
    el.style.animationDuration=dur+'s';
    el.style.animationDelay='-'+del+'s';

    var clickTimer=null;
    el.addEventListener('click',function(e){
      e.stopPropagation();
      if(clickTimer){clearTimeout(clickTimer);clickTimer=null;return}
      clickTimer=setTimeout(function(){
        clickTimer=null;
        toggleNode(id,kind);
        selId=id;
        rebuildDOM();
      },200);
    });
    el.addEventListener('dblclick',function(e){
      e.stopPropagation();
      if(clickTimer){clearTimeout(clickTimer);clickTimer=null}
      navStack=[];
      showDetail(id,kind);
    });
    return el;
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

  function render(){
    // position nodes
    Object.keys(nodeEls).forEach(function(id){
      var p=pos[id];if(!p)return;
      var sp=w2s(p.x,p.y);
      var w=eById[id]?EW:EVW,h=eById[id]?EH:EVH;
      var el=nodeEls[id];
      el.style.left=sp.x+'px';
      el.style.top=sp.y+'px';
      el.style.width=(w*cam.zoom)+'px';
      el.style.height=(h*cam.zoom)+'px';
      el.style.fontSize=Math.max(8,12*cam.zoom)+'px';
    });

    // position edges
    edgeEls.forEach(function(line){
      var srcId=line.getAttribute('data-src');
      var tgtId=line.getAttribute('data-tgt');
      var sp=pos[srcId],tp=pos[tgtId];
      if(!sp||!tp)return;
      var s=w2s(sp.x+EW/2,sp.y+EH/2);
      var t=w2s(tp.x+EVW/2,tp.y+EVH/2);
      line.setAttribute('x1',s.x);line.setAttribute('y1',s.y);
      line.setAttribute('x2',t.x);line.setAttribute('y2',t.y);
    });
  }

  // click background to deselect
  container.addEventListener('click',function(e){
    if(e.target===container||e.target===svg){selId=null;rebuildDOM()}
  });

  // detail panel
  function showDetail(id,kind,pushNav){
    if(pushNav!==false)navStack.push({id:id,kind:kind});
    var panel=document.getElementById('detail');
    var body=document.getElementById('detail-body');
    var html='';
    if(navStack.length>1)html+='<button class="back-btn" id="btn-back">← 返回</button>';
    if(kind==='entity'){
      var e=eById[id];
      html+='<div class="type-tag">'+esc(e.type)+'</div>';
      html+='<h3>'+esc(e.name)+'</h3>';
      html+='<div class="field"><div class="label">关联事件</div><div class="value">'+(e.eventCount||0)+' 个</div></div>';
      var ce=evByEnt[id]||[];
      if(ce.length){html+='<div class="divider"></div><div class="field"><div class="label">事件列表</div>';ce.forEach(function(eid){var ev=evById[eid];if(ev)html+='<div class="conn-item" data-id="'+eid+'" data-kind="event">'+esc(ev.title)+'</div>'});html+='</div>'}
    }else{
      var ev=evById[id];
      html+='<h3>'+esc(ev.title)+'</h3>';
      var ce=entByEv[id]||[];
      if(ce.length){html+='<div class="divider"></div><div class="field"><div class="label">关联实体</div>';ce.forEach(function(eid){var e=eById[eid];if(e)html+='<div class="conn-item" data-id="'+eid+'" data-kind="entity">'+esc(e.name)+'<span class="badge">'+esc(e.type)+'</span></div>'});html+='</div>'}
    }
    body.innerHTML=html;panel.classList.add('open');
    var backBtn=document.getElementById('btn-back');
    if(backBtn)backBtn.addEventListener('click',function(){
      navStack.pop();
      var prev=navStack[navStack.length-1];
      if(prev){selId=prev.id;rebuildDOM();showDetail(prev.id,prev.kind,false)}
      else{panel.classList.remove('open')}
    });
    body.querySelectorAll('.conn-item').forEach(function(el){
      el.addEventListener('click',function(){
        var nid=el.getAttribute('data-id'),nk=el.getAttribute('data-kind');
        if(nk==='entity'&&!expEnt.has(nid))expEnt.add(nid);
        if(nk==='event'&&!expEv.has(nid))expEv.add(nid);
        selId=nid;rebuildDOM();showDetail(nid,nk);
      });
    });
  }

  function esc(s){if(!s)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

  document.getElementById('btn-reset').onclick=function(){expEnt.clear();expEv.clear();selId=null;graphData.entities.forEach(function(e){expEnt.add(e.id)});document.getElementById('detail').classList.remove('open');navStack=[];fitView();rebuildDOM()};
  document.getElementById('btn-expand').onclick=function(){graphData.entities.forEach(function(e){expEnt.add(e.id)});graphData.events.forEach(function(e){expEv.add(e.id)});selId=null;document.getElementById('detail').classList.remove('open');fitView();rebuildDOM()};
  document.getElementById('btn-close').onclick=function(){document.getElementById('detail').classList.remove('open');navStack=[]};
})();
${'</'}script>
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
      entities: entities.map(({ id, sourceId, type, name, normalizedName, eventCount }) => ({
        id, sourceId, type, name, normalizedName, eventCount,
      })),
      events: events.map(({ id, sourceId, documentId, title, rank }) => ({
        id, sourceId, documentId, title, rank,
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

function serveHTML(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(HTML);
}

// ─── Public API ─────────────────────────────────────────────────────

export async function handleWeb(host: SlashCommandHost): Promise<void> {
  const store = await getKnowledgeStore();
  const s = await store.stats();
  if (s.entities === 0 && s.events === 0) {
    throw new Error('知识库为空，请先用 /knowledge 摄入文档');
  }

  const server = createServer((req, res) => {
    if (req.url === '/api/graph') {
      void serveGraphJSON(store, res);
      return;
    }
    serveHTML(res);
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
  host.showStatus(`知识图谱已打开: ${url}`);
}
