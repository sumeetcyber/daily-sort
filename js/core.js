const STORAGE = "daily-sort-v1";
const SESSION_KEY = "daily-sort-session-key";
const THEME_KEY="daily-sort-theme";
const DRAFT_KEY="daily-sort-bulk-draft-v1";
const LEGACY_SESSION_SALT_PREFIX="daily-sort-session-v1:";
const SUPABASE_URL = "https://cepdhdpzahqthrtyqogo.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Hjvm2fSk4P1lR46pxIIcKQ_dnen3qS2";
let sb = window.supabase?.createClient
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
  : null;
let supabaseLoadPromise = null;
async function ensureSupabase(){
  if(sb)return sb;
  if(supabaseLoadPromise)return supabaseLoadPromise;
  supabaseLoadPromise=(async()=>{
    const urls=[
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
      "https://unpkg.com/@supabase/supabase-js@2"
    ];
    for(const url of urls){
      try{
        await new Promise((resolve,reject)=>{
          const script=document.createElement("script");
          script.src=url;script.async=true;
          script.onload=resolve;script.onerror=()=>reject(new Error("Could not load Supabase client"));
          document.head.appendChild(script);
        });
        if(window.supabase?.createClient){
          sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);
          return sb;
        }
      }catch(err){console.warn("Supabase CDN attempt failed",url,err)}
    }
    throw new Error("Supabase client library unavailable. Check network or content blockers.");
  })();
  try{return await supabaseLoadPromise}
  catch(err){supabaseLoadPromise=null;throw err}
}
let cloudTimer = null;
let cloudReady = false;
let syncingCloud = false;
let realtimeChannel = null;
let realtimeToken = null;
let applyingRemote = false;
let localChangeAt = 0;

let state = {
  tasks: []
};

function id(){
  return crypto.randomUUID ? crypto.randomUUID() : Date.now()+"-"+Math.random().toString(16).slice(2);
}

const undoStack=[],redoStack=[];
let lastSavedSnapshot=null,suppressUndoCapture=false,lastDraftSnapshot="",suppressDraftCapture=false;
function currentDraft(){return document.getElementById("bulkInput")?.value||"";}
function updateUndoButton(){const u=document.getElementById("undoAction"),r=document.getElementById("redoAction");if(u)u.disabled=!undoStack.length;if(r)r.disabled=!redoStack.length;}
function pushHistory(entry){undoStack.push(entry);if(undoStack.length>100)undoStack.shift();redoStack.length=0;updateUndoButton();}
function save(){
 localChangeAt=Date.now();const next=JSON.stringify(state);
 if(!suppressUndoCapture&&lastSavedSnapshot!==null&&next!==lastSavedSnapshot)pushHistory({type:"tasks",before:lastSavedSnapshot,after:next,draft:currentDraft()});
 localStorage.setItem(STORAGE,next);lastSavedSnapshot=next;updateUndoButton();queueCloudSave();
}
function setDraftValue(value){const box=document.getElementById("bulkInput");if(!box)return;suppressDraftCapture=true;box.value=value;lastDraftSnapshot=value;try{localStorage.setItem(DRAFT_KEY,value);}catch(e){}suppressDraftCapture=false;}
function undoLastAction(){
 if(!undoStack.length)return;const entry=undoStack.pop();
 if(entry.type==="draft"){setDraftValue(entry.before);}
 else{try{const before=JSON.parse(entry.before),after=JSON.parse(entry.after);const ids=new Set((before.tasks||[]).map(t=>t.id));const added=(after.tasks||[]).filter(t=>!ids.has(t.id));state=before;
 if(added.length){const recovered=added.map(t=>t.text||t.title||"").filter(Boolean).join("\n");const draft=currentDraft();setDraftValue([draft,recovered].filter(Boolean).join(draft&&recovered?"\n":""));}
 localStorage.setItem(STORAGE,JSON.stringify(state));lastSavedSnapshot=JSON.stringify(state);queueCloudSave();render();}catch(e){toast("Undo unavailable");}}
 redoStack.push(entry);updateUndoButton();persistDraft();toast("Last change undone ↶");
}
function redoLastAction(){
 if(!redoStack.length)return;const entry=redoStack.pop();
 if(entry.type==="draft"){setDraftValue(entry.after);}
 else{try{state=JSON.parse(entry.after);localStorage.setItem(STORAGE,JSON.stringify(state));lastSavedSnapshot=JSON.stringify(state);setDraftValue(entry.draft||"");queueCloudSave();render();}catch(e){toast("Redo unavailable");}}
 undoStack.push(entry);updateUndoButton();persistDraft();toast("Change redone ↷");
}

function load(){
  try{
    const raw=localStorage.getItem(STORAGE);
    if(raw) state=JSON.parse(raw);
    state.tasks=Array.isArray(state.tasks)?state.tasks:[];
    state.tasks.forEach(t=>{delete t.groupId;if(!t.zone)t.zone="today";if(!("notes" in t))t.notes="";if(!("open" in t))t.open=false;});
  }catch(e){state={tasks:[]};}
}

function escapeHtml(s){
  return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}

function persistDraft(){
 const box=document.getElementById("bulkInput");if(!box)return;const value=box.value;
 if(!suppressDraftCapture&&value!==lastDraftSnapshot)pushHistory({type:"draft",before:lastDraftSnapshot,after:value});
 lastDraftSnapshot=value;try{localStorage.setItem(DRAFT_KEY,value);}catch(e){}
 const status=document.getElementById("draftStatus");if(status)status.textContent="Draft saved locally · "+new Date().toLocaleTimeString("en-GB",{hour12:false});queueCloudSave();
}
function initDrafts(){
 const box=document.getElementById("bulkInput");try{box.value=localStorage.getItem(DRAFT_KEY)||"";}catch(e){}
 lastDraftSnapshot=box.value;box.addEventListener("input",persistDraft);box.addEventListener("blur",()=>{try{localStorage.setItem(DRAFT_KEY,box.value);}catch(e){}});
}

function parseBulkTasks(input){
  const source=String(input||"");
  const tasks=[];
  const pushUnwrapped=chunk=>{
    const lines=chunk.split(/\r?\n/);let plain=[];
    const flush=()=>{plain.map(x=>x.trim()).filter(Boolean).forEach(x=>tasks.push(x));plain=[];};
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      const standalone=line.match(/^\s*\(\(\(\(\(\(\(\((.*?)\)\)\)\)\)\)\)\)\s*$/);
      if(standalone){flush();if(standalone[1].trim())tasks.push({__dailySortHeader:true,title:standalone[1].trim()});continue;}
      const open=line.match(/^\s*\(\(\(\(\(\(\(\((.*?)\s*$/);
      if(open&&!/\)\)\)\)\)\)\)\)$/.test(open[1])){
        let close=i+1;
        while(close<lines.length&&!/^\s*\)\)\)\)\)\)\)\)\s*$/.test(lines[close]))close++;
        if(close<lines.length){
          flush();
          const title=open[1].trim();
          tasks.push({__dailySortHeader:true,title});
          lines.slice(i+1,close).map(x=>x.trim()).filter(Boolean).forEach(x=>tasks.push(x));
          i=close;continue;
        }
      }
      const titled=/^\s*\+\+\+\+[ \t]+.+?[ \t]+\/\/\/\/\s*$/.test(line);
      if(titled){let end=i+1;while(end<lines.length&&lines[end].trim()!=="++++")end++;
        if(end<lines.length){flush();const content=lines.slice(i+1,end).join("\n").trim();const tm=line.match(/^\s*\+\+\+\+[ \t]+(.+?)[ \t]+\/\/\/\/\s*$/);tasks.push(`++++ ${tm[1].trim()} ////\n${content}\n++++`);i=end;continue;}
      }
      plain.push(line);
    }flush();
  };
  const wrapped=/>>>>([\s\S]*?)<<<<(?=\r?\n|$)/g;let cursor=0,m;
  while((m=wrapped.exec(source))!==null){pushUnwrapped(source.slice(cursor,m.index));tasks.push(m[1].replace(/^\r?\n|\r?\n$/g,""));cursor=wrapped.lastIndex;}
  pushUnwrapped(source.slice(cursor));
  return tasks.filter(x=>typeof x==="object"||String(x).trim().length>0);
}
function formatTaskForPaste(text){
  return String(text??"").includes("\n") || String(text??"").includes("\r") ? ">>>>"+text+"<<<<" : String(text??"");
}
function splitTaskNotes(raw){
  const value=String(raw??"");
  const match=value.match(/\n?\s*~~~~Notes:\s*\n([\s\S]*?)\n?~~~~\s*$/i);
  if(!match) return {text:value.trim(),notes:""};
  return {text:value.slice(0,match.index).trim(),notes:match[1].trim()};
}
function addTasksFromText(zone="today"){
  const box=document.getElementById("bulkInput");
  const lines=parseBulkTasks(box.value);
  if(!lines.length) return;
  persistDraft();
  lines.forEach(raw=>{
    if(raw&&raw.__dailySortHeader){state.tasks.push({id:id(),text:raw.title,zone,isHeader:true,created:Date.now()});return;}
    const parsed=splitTaskNotes(raw);
    state.tasks.push({id:id(),text:parsed.text,notes:parsed.notes,zone,done:false,open:false,created:Date.now()});
  });
  box.value="";
  persistDraft(false);
  save(); render();
  toast((lines.length===1?"Added":""+lines.length+" added")+" to "+(zone==="later"?"Not Today":"Today")+" ✨");
}
function dumpZone(zone){
  const sequence=state.tasks.filter(t=>(t.zone==="later"?"later":"today")===zone);
  if(!sequence.length){toast("No tasks to dump");return;}
  const output=[];let i=0;
  while(i<sequence.length){
    const item=sequence[i];
    if(item.isHeader){
      const children=[];let j=i+1;
      while(j<sequence.length&&!sequence[j].isHeader){
        const t=sequence[j],notes=String(t.notes??"").trim();
        const body=notes?String(t.text??"")+"\n\n~~~~Notes:\n"+notes+"\n~~~~":String(t.text??"");
        children.push(body.includes("\n")||body.includes("\r")?">>>>"+body+"<<<<":body);
        j++;
      }
      if(children.length)output.push("(((((((( "+String(item.text??"")+"\n"+children.join("\n")+"\n))))))))");
      else output.push("(((((((( "+String(item.text??"")+" ))))))))");
      i=j;continue;
    }
    const notes=String(item.notes??"").trim();
    const body=notes?String(item.text??"")+"\n\n~~~~Notes:\n"+notes+"\n~~~~":String(item.text??"");
    output.push(body.includes("\n")||body.includes("\r")?">>>>"+body+"<<<<":body);i++;
  }
  const box=document.getElementById("bulkInput");
  box.value=[box.value.trim(),...output].filter(Boolean).join("\n");
  persistDraft();
  const ids=new Set(sequence.map(t=>t.id));state.tasks=state.tasks.filter(t=>!ids.has(t.id));
  selectedTaskIds.clear();save();render();box.focus();
  toast(sequence.length+" entries moved to the paste box");
}

const selectedTaskIds = new Set();
function updateSelectionCount(){
  const el=document.getElementById("selectionCount");
  if(el)el.textContent=selectedTaskIds.size+" selected";
  const arrangeCount=document.getElementById("arrangeSelectionCount");
  if(arrangeCount)arrangeCount.textContent=selectedTaskIds.size+" selected · from either column";
  const clearButton=document.getElementById("clearSelection");
  const deleteButton=document.getElementById("deleteSelected");
  if(deleteButton)deleteButton.hidden=selectedTaskIds.size===0;
  const arrangePanel=document.getElementById("arrangeTools");
  const toolbar=document.querySelector(".bulk-tools");
  const selectionCount=document.getElementById("selectionCount");
  const stepOne=document.querySelector("#arrangeTools .arrange-step:first-child .arrange-step-content");
  if(clearButton&&toolbar&&selectionCount&&stepOne){
    if(arrangePanel&&!arrangePanel.hidden){
      stepOne.appendChild(clearButton);
    }else{
      selectionCount.insertAdjacentElement("afterend",clearButton);
    }
    clearButton.hidden=selectedTaskIds.size===0;
  }
  updateMoveRange();
}
function updateMoveRange(){
  const input=document.getElementById("moveAboveNumber");
  const target=document.getElementById("moveTargetZone");
  if(!input||!target)return;
  const zone=target.value;
  const count=state.tasks.filter(t=>(t.zone==="later"?"later":"today")===zone).length;
  const selectedInTarget=state.tasks.filter(t=>selectedTaskIds.has(t.id)&&(t.zone==="later"?"later":"today")===zone).length;
  const remaining=count-selectedInTarget;
  const max=Math.max(1,remaining+1);
  input.max=String(max);
  input.min="1";
  input.placeholder="1–"+max;
  const current=Number(input.value);
  if(!Number.isInteger(current)||current<1||current>max)input.value=String(max);
  const help=document.getElementById("moveRangeHelp");
  if(help)help.textContent=`${count} tasks in ${zone==="today"?"Today":"Not Today"} · valid positions 1–${max}`;
}

const TASK_PALETTES={Forest:{bg:"#244B3A",fg:"#E5F5E9"},Ocean:{bg:"#263D62",fg:"#E6F0FF"},Plum:{bg:"#49345D",fg:"#F3E8FF"},Amber:{bg:"#66452B",fg:"#FFF0D9"},Rose:{bg:"#63353D",fg:"#FFE9EC"},Slate:{bg:"#34434B",fg:"#EAF3F6"},Sage:{bg:"#DCEBDD",fg:"#203D2B"},Sand:{bg:"#F5E8CE",fg:"#49391F"},Purple:{bg:"#49345D",fg:"#F3E8FF"},Blue:{bg:"#263D62",fg:"#E6F0FF"},Cyan:{bg:"#164C58",fg:"#E0FAFF"},Teal:{bg:"#174D49",fg:"#DDF8F3"},Green:{bg:"#244B3A",fg:"#E5F5E9"},Lime:{bg:"#3E4D20",fg:"#F0F8D9"},Yellow:{bg:"#5B4B1D",fg:"#FFF6D6"},Orange:{bg:"#66452B",fg:"#FFF0D9"},Red:{bg:"#63353D",fg:"#FFE9EC"},Pink:{bg:"#633D59",fg:"#FFEAF7"},White:{bg:"#34434B",fg:"#F4F4F4"}};
const TASK_COLORS=Object.fromEntries(Object.entries(TASK_PALETTES).map(([n,p])=>[n,p.bg]));
const TASK_TEXT_COLORS=Object.fromEntries(Object.entries(TASK_PALETTES).map(([n,p])=>[n,p.fg]));
function parseColorSyntax(text){
  const raw=String(text||"");
  const patterns=[
    /^\s*\{\{(Purple|Blue|Cyan|Teal|Green|Lime|Yellow|Orange|Red|Pink|Rose|White)\}\}\s*([\s\S]*?)\s*\{\{\/Color\}\}\s*$/i
  ];
  for(const re of patterns){
    const m=raw.match(re);if(!m)continue;
    const name=Object.keys(TASK_COLORS).find(k=>k.toLowerCase()===m[1].toLowerCase())||null;
    return {color:name?TASK_COLORS[name]:(m[1].startsWith("#")?m[1]:null),textColor:name?TASK_TEXT_COLORS[name]:null,name,body:m[2]};
  }
  return {color:null,textColor:null,name:null,body:raw};
}
function withColorSyntax(body,name){return name?`{{${name}}}\n${body}\n{{/Color}}`:body;}

function parseToggleList(text){
  const source=parseColorSyntax(text).body;
  const raw=String(source||"");
  const titled=raw.match(/^\s*\+\+\+\+[ \t]+(.+?)[ \t]+\/\/\/\/\s*\r?\n([\s\S]*?)\r?\n\+\+\+\+\s*$/);
  if(!titled)return null;
  const rows=titled[2].split(/\r?\n/).filter(line=>line.length>0).map((line,index)=>{
    const item=line.match(/^\s*\[([ xX])\]\s?(.*)$/);
    return {done:!!item&&item[1].toLowerCase()==="x",text:item?item[2]:line,index};
  });
  rows.title=titled[1].trim();
  return rows;
}
function toggleListMarkup(t){
  const parsed=parseToggleList(t.text);
  if(!parsed)return "";
  return `<div class="toggle-list" data-toggle-list="${t.id}">${parsed.map((item,i)=>`
    <div class="toggle-list-row ${item.done?"done":""}" data-list-index="${i}">
      <input type="checkbox" data-action="toggle-item" ${item.done?"checked":""} aria-label="Toggle list item">
      <input type="text" data-action="edit-item" value="${escapeHtml(item.text)}" aria-label="Toggle list item text">
      <span class="toggle-row-tools"><button type="button" data-action="item-up" aria-label="Move item up" title="Move up" ${i===0?"disabled":""}>↑</button><button type="button" data-action="item-down" aria-label="Move item down" title="Move down" ${i===parsed.length-1?"disabled":""}>↓</button></span>
    </div>`).join("")}</div>`;
}
function taskToolbar(t,number){
  const direction=t.zone==="later"?"⇦":"⇨";
  const destination=t.zone==="later"?"Move to Today":"Move to Not Today";
  return `<div class="card-tools" contenteditable="false">
    <div class="tool-cell"><button class="check" data-action="complete" title="Complete" aria-label="Complete task"></button></div>
    <div class="tool-cell tool-cell-number"><span class="toolbar-task-number">${number}</span></div>
    <div class="tool-cell"><button class="icon-btn reorder-arrow" data-action="up" title="Move task up" aria-label="Move task up">↑</button></div>
    <div class="tool-cell"><button class="icon-btn reorder-arrow" data-action="down" title="Move task down" aria-label="Move task down">↓</button></div>
    <div class="tool-cell"><input class="select-task" type="checkbox" data-action="select-task" ${selectedTaskIds.has(t.id)?"checked":""} aria-label="Select task for bulk actions" title="Select task for bulk actions"></div>
    <div class="tool-cell tool-cell-move"><button class="icon-btn zone-arrow" data-action="move-later" title="${destination}" aria-label="${destination}">${direction}</button></div>
    <div class="tool-cell tool-cell-expand"><button class="expand" data-action="expand" title="${t.open?"Collapse":"Expand"} details" aria-label="${t.open?"Collapse":"Expand"} details">${t.open?"🔼":"🔽"}</button></div>
  </div>`;
}
function taskCard(t,number){
  const colorInfo=parseColorSyntax(t.text);
  const color=t.colorHex||colorInfo.color;
  const textColor=t.textColorHex||colorInfo.textColor;
  const checklist=parseToggleList(t.text);
  const title=escapeHtml(parseColorSyntax(t.text).body).replace(/\n/g,"<br>");
  const content=checklist
    ? `<div class="toggle-list-heading"><button class="toggle-list-collapse" data-action="toggle-list-collapse" aria-expanded="${!t.listCollapsed}" title="${t.listCollapsed?"Expand":"Collapse"} list">${t.listCollapsed?"▸":"▾"}</button><input class="toggle-list-title-edit" data-action="toggle-list-title" type="text" value="${escapeHtml(checklist.title)}" aria-label="Edit checklist title" title="Edit checklist title"><span class="toggle-list-count">${checklist.length} items</span></div>${t.listCollapsed?"":toggleListMarkup(t)}`
    : `<div class="task-title-edit" data-action="title" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Task title" spellcheck="false"><span class="task-text-content" data-task-text>${title}</span></div>`;
  return `<article class="card ${t.done?"done":""} ${t.open?"open":""} ${selectedTaskIds.has(t.id)?"selected":""}" draggable="true" data-id="${t.id}" ${color?`data-task-color style="--task-color:${color};--task-bg:${color};--task-fg:${textColor||"#FFFFFF"}"`:""}>
    <div class="card-main"><span class="task-number" aria-hidden="true">${number}</span><div class="task-body">${content}<button class="insert-below" data-action="insert-below" type="button" title="Add task below" aria-label="Add task below">＋</button>${taskToolbar(t,number)}</div></div>
    <div class="details"><textarea data-action="notes" placeholder="Notes…">${escapeHtml(t.notes)}</textarea><div class="details-row"><button class="btn" data-action="move-later">${t.zone==="later"?"Move to Today":"Not Today"}</button><button class="btn" data-action="delete">Delete</button></div></div>
  </article>`;
}
function renderCards(){
  const todayAll=state.tasks.filter(t=>!t.isHeader&&t.zone!=="later"),laterAll=state.tasks.filter(t=>!t.isHeader&&t.zone==="later");
  const q=(document.getElementById("taskSearch")?.value||"").trim().toLocaleLowerCase();
  const renderZone=(zone,container,all)=>{
    const sequence=state.tasks.filter(t=>(t.zone==="later"?"later":"today")===zone);const groups=[];let group={header:null,items:[]};
    sequence.forEach(item=>{
      if(item.isHeader){if(group.header||group.items.length)groups.push(group);group={header:item,items:[]};}
      else if(!q||[parseColorSyntax(item.text).body,item.notes||""].join("\n").toLocaleLowerCase().includes(q))group.items.push(item);
    });
    if(group.header||group.items.length)groups.push(group);
    const markup=groups.map(g=>{if(!g.header&&!g.items.length)return "";const hi=g.header?parseColorSyntax(g.header.text):null;const h=g.header?`<div class="section-header-card ${selectedTaskIds.has(g.header.id)?"selected":""}" role="heading" aria-level="2" draggable="true" data-id="${g.header.id}" ${hi.color?`data-task-color style="--task-bg:${hi.color};--task-fg:${hi.textColor||"#fff"}"`:""}><span class="section-header-title" contenteditable="true" spellcheck="false" aria-label="Edit section header">${escapeHtml(hi.body)}</span></div>`:"";return `<section class="task-section">${h}${g.items.map(t=>taskCard(t,all.indexOf(t)+1)).join("")}</section>`;}).join("");
    container.innerHTML=markup||(q?`<div class="empty search-empty">No ${zone==="today"?"Today":"Not Today"} tasks match “${escapeHtml(q)}”.</div>`:`<div class="empty">${zone==="today"?"No tasks for today.<br>Paste a bunch above and start sorting.":"Nothing parked here.<br>Drag a task here when it isn't today's problem."}</div>`);
  };
  renderZone("today",document.getElementById("todayCards"),todayAll);renderZone("later",document.getElementById("laterCards"),laterAll);
  document.getElementById("todayCount").textContent=todayAll.length;document.getElementById("laterCount").textContent=laterAll.length;
  const count=document.getElementById("searchResultCount");if(count)count.textContent=q?`${document.querySelectorAll("#todayCards .card").length+document.querySelectorAll("#laterCards .card").length} of ${todayAll.length+laterAll.length} tasks`:"All tasks";
}
function bindHeaderActions(){
  document.querySelectorAll(".section-header-card").forEach(header=>{
    const hid=header.dataset.id;
    const item=state.tasks.find(t=>t.id===hid);
    if(!item)return;
    const editor=header.querySelector(".section-header-title");
    header.addEventListener("click",e=>{
      if(e.target===editor)return;
      if(selectedTaskIds.has(hid))selectedTaskIds.delete(hid);else selectedTaskIds.add(hid);
      header.classList.toggle("selected",selectedTaskIds.has(hid));
      updateSelectionCount();
    });
    editor.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();editor.blur();}});
    editor.addEventListener("blur",()=>{
      const value=(editor.innerText||editor.textContent||"").trim();
      const parsed=parseColorSyntax(item.text);
      item.text=withColorSyntax(value,parsed.name);
      save();render();
    });
    editor.addEventListener("input",()=>{item.text=withColorSyntax((editor.innerText||editor.textContent||"").trim(),parseColorSyntax(item.text).name);});
    editor.addEventListener("pointerdown",e=>e.stopPropagation());
  });
}
function render(){
  for(const sid of [...selectedTaskIds])if(!state.tasks.some(t=>t.id===sid))selectedTaskIds.delete(sid);
  renderCards(); bindDnD(); bindActions(); bindHeaderActions(); updateSelectionCount();
}

let movementNumberTimer=null;
function keepMoveControlInPlace(tid,direction,swappedIds=[],displacedId=null,pointerPoint=null){
  requestAnimationFrame(()=>{
    const movingCard=document.querySelector(`.card[data-id="${tid}"]`);
    const movingButton=movingCard?.querySelector(`[data-action="${direction<0?"up":"down"}"]`);
    if(!movingButton)return;
    movingButton.focus({preventScroll:true});
    if(pointerPoint){
      const cards=movingButton.closest(".cards");
      const fixed=document.body.dataset.panelHeight!=="dynamic";
      const canScrollCards=fixed&&cards&&cards.scrollHeight>cards.clientHeight+1;
      const rect=movingButton.getBoundingClientRect();
      const dx=rect.left+rect.width/2-pointerPoint.x,dy=rect.top+rect.height/2-pointerPoint.y;
      if(canScrollCards){
        const before=cards.scrollTop;
        cards.scrollTop=Math.max(0,Math.min(cards.scrollHeight-cards.clientHeight,before+dy));
        const remainder=dy-(cards.scrollTop-before);
        if(Math.abs(remainder)>1)window.scrollBy({left:dx,top:remainder,behavior:"instant"});
      }else window.scrollBy({left:dx,top:dy,behavior:"instant"});
      requestAnimationFrame(()=>{
        const after=movingButton.getBoundingClientRect();
        const rx=after.left+after.width/2-pointerPoint.x,ry=after.top+after.height/2-pointerPoint.y;
        if(canScrollCards){
          const before=cards.scrollTop;
          cards.scrollTop=Math.max(0,Math.min(cards.scrollHeight-cards.clientHeight,before+ry));
          const remainder=ry-(cards.scrollTop-before);
          if(Math.abs(remainder)>1)window.scrollBy({left:rx,top:remainder,behavior:"instant"});
        }else window.scrollBy({left:rx,top:ry,behavior:"instant"});
      });
    }
    const displacedCard=displacedId&&document.querySelector(`.card[data-id="${displacedId}"]`);
    const displacedArrow=displacedCard?.querySelector(`[data-action="${direction<0?"down":"up"}"]`);
    if(displacedArrow){displacedArrow.classList.remove("movement-arrow-pulse");void displacedArrow.offsetWidth;displacedArrow.classList.add("movement-arrow-pulse");setTimeout(()=>displacedArrow.classList.remove("movement-arrow-pulse"),650);}
    swappedIds.forEach(id=>{const card=document.querySelector(`.card[data-id="${id}"]`);if(card){card.classList.remove("task-swap-flash");void card.offsetWidth;card.classList.add("task-swap-flash");setTimeout(()=>card.classList.remove("task-swap-flash"),650);}});
  });
}
function moveTask(tid, direction, pointerPoint=null){
  const index=state.tasks.findIndex(t=>t.id===tid);
  if(index<0)return;
  const task=state.tasks[index];
  const sameZone=state.tasks
    .map((t,i)=>({t,i}))
    .filter(x=>(x.t.zone==="later"?"later":"today") === (task.zone==="later"?"later":"today"));
  const pos=sameZone.findIndex(x=>x.i===index);
  const targetPos=pos+direction;
  if(targetPos<0 || targetPos>=sameZone.length)return;
  const targetIndex=sameZone[targetPos].i;
  const displacedId=state.tasks[targetIndex].id;
  const swappedIds=[state.tasks[index].id,displacedId];
  [state.tasks[index],state.tasks[targetIndex]]=[state.tasks[targetIndex],state.tasks[index]];
  document.body.classList.add("movement-numbers");
  if(movementNumberTimer)clearTimeout(movementNumberTimer);
  movementNumberTimer=setTimeout(()=>document.body.classList.remove("movement-numbers"),1800);
  save();
  render();
  keepMoveControlInPlace(tid,direction,swappedIds,displacedId,pointerPoint);
}

function moveTaskBefore(dragId, targetId){
  if(dragId===targetId)return;
  const from=state.tasks.findIndex(t=>t.id===dragId);
  const to=state.tasks.findIndex(t=>t.id===targetId);
  if(from<0 || to<0)return;

  const dragged=state.tasks[from];
  const target=state.tasks[to];
  if((dragged.zone==="later") !== (target.zone==="later"))return;

  state.tasks.splice(from,1);
  const newTarget=state.tasks.findIndex(t=>t.id===targetId);
  state.tasks.splice(newTarget,0,dragged);
  save();
  render();
}

function bindToggleRowControls(card,t,syncToggleText){
  card.querySelectorAll('[data-action="item-up"],[data-action="item-down"]').forEach(button=>{
    button.onclick=e=>{
      e.preventDefault();e.stopPropagation();
      const row=button.closest(".toggle-list-row");
      const rows=[...card.querySelectorAll(".toggle-list-row")];
      const index=rows.indexOf(row),direction=button.dataset.action==="item-up"?-1:1;
      const target=rows[index+direction];
      if(!row||!target)return;
      if(direction<0)target.before(row);else target.after(row);
      syncToggleText();
      const list=card.querySelector(".toggle-list");
      if(list)list.outerHTML=toggleListMarkup(t);
      bindToggleRowControls(card,t,syncToggleText);
    };
  });
}

function taskEditorText(editor){
  const text=editor?.querySelector('[data-task-text]');
  if(!text)return '';
  return (text.innerText||text.textContent||'').replace(/\u00a0/g,' ').replace(/\r/g,'');
}
function insertTaskEditorBreak(editor){
  const text=editor.querySelector('[data-task-text]');if(!text)return;
  const selection=window.getSelection();let range;
  if(selection&&selection.rangeCount&&text.contains(selection.anchorNode))range=selection.getRangeAt(0);
  else{range=document.createRange();range.selectNodeContents(text);range.collapse(false);}
  range.deleteContents();const br=document.createElement('br');range.insertNode(br);
  range.setStartAfter(br);range.collapse(true);selection.removeAllRanges();selection.addRange(range);
}
function focusTaskEditor(editor){
  editor?.focus();const text=editor?.querySelector('[data-task-text]');if(!text)return;
  const range=document.createRange();range.selectNodeContents(text);range.collapse(false);
  const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);
}

let lastArrowPointer=null;
function bindActions(){
  document.querySelectorAll(".card").forEach(card=>{
    const tid=card.dataset.id;
    const t=state.tasks.find(x=>x.id===tid);
    const selectionBox=card.querySelector('[data-action="select-task"]');
    card.querySelectorAll(".card-tools button,.card-tools input").forEach(control=>control.addEventListener("pointerdown",e=>e.stopPropagation()));
    selectionBox.addEventListener("click",e=>e.stopPropagation());
    selectionBox.onchange=e=>{
      if(e.target.checked)selectedTaskIds.add(tid);else selectedTaskIds.delete(tid);
      card.classList.toggle("selected",e.target.checked);updateSelectionCount();
    };
    card.querySelector('[data-action="complete"]').onclick=e=>{
      e.stopPropagation(); t.done=!t.done; save();render();
    };
    const upButton=card.querySelector('[data-action="up"]');
    const downButton=card.querySelector('[data-action="down"]');
    [upButton,downButton].forEach(button=>button.addEventListener("pointerdown",e=>{lastArrowPointer={x:e.clientX,y:e.clientY};},{passive:true}));
    upButton.onclick=e=>{e.preventDefault();e.stopPropagation();moveTask(tid,-1,lastArrowPointer||{x:e.clientX,y:e.clientY});lastArrowPointer=null;};
    downButton.onclick=e=>{e.preventDefault();e.stopPropagation();moveTask(tid,1,lastArrowPointer||{x:e.clientX,y:e.clientY});lastArrowPointer=null;};
    card.querySelector('[data-action="expand"]').onclick=e=>{
      e.stopPropagation(); t.open=!t.open; save();render();
    };
    const listCollapse=card.querySelector('[data-action="toggle-list-collapse"]');
    if(listCollapse)listCollapse.onclick=e=>{
      e.stopPropagation();t.listCollapsed=!t.listCollapsed;save();render();
    };
    card.querySelectorAll('input[type="text"], textarea, [contenteditable="true"]').forEach(editor=>{
      editor.draggable=false;
      editor.addEventListener("pointerdown",e=>{
        card.draggable=false;
        e.stopPropagation();
      });
      editor.addEventListener("focus",()=>{card.draggable=false;});
      editor.addEventListener("blur",()=>{card.draggable=true;});
      editor.addEventListener("dragstart",e=>e.preventDefault());
    });
    card.querySelectorAll('[data-action="toggle-item"],[data-action="select-task"]').forEach(control=>{
      control.addEventListener("pointerdown",e=>e.stopPropagation());
    });
    const titleEditor=card.querySelector('[data-action="title"]');
    const fitTitle=()=>{if(titleEditor)titleEditor.style.height="auto";};
    const fitTitleKeepingViewport=()=>{
      if(!titleEditor)return;const beforeTop=titleEditor.getBoundingClientRect().top;
      const cardsScroller=card.closest(".cards");fitTitle();
      requestAnimationFrame(()=>{
        const drift=titleEditor.getBoundingClientRect().top-beforeTop;if(Math.abs(drift)<1)return;
        if(cardsScroller&&cardsScroller.scrollHeight>cardsScroller.clientHeight){
          const before=cardsScroller.scrollTop;
          cardsScroller.scrollTop=Math.max(0,Math.min(cardsScroller.scrollHeight-cardsScroller.clientHeight,before+drift));
          const remainder=drift-(cardsScroller.scrollTop-before);
          if(Math.abs(remainder)>1)window.scrollBy({top:remainder,left:0,behavior:"instant"});
        }else window.scrollBy({top:drift,left:0,behavior:"instant"});
      });
    };
    fitTitle();
    if(titleEditor)titleEditor.addEventListener("input",e=>{
      const value=taskEditorText(e.currentTarget);
      const typedColor=parseColorSyntax(value);const currentColor=parseColorSyntax(t.text).name;
      t.text=typedColor.name?value:withColorSyntax(value,currentColor);
      fitTitleKeepingViewport();save();
      const preview=card.querySelector('.toggle-list');
      const markup=toggleListMarkup(t);
      if(preview){if(markup)preview.outerHTML=markup;else preview.remove();}
      else if(markup)titleEditor.insertAdjacentHTML('afterend',markup);
    });
    if(titleEditor)titleEditor.addEventListener("keydown",e=>{
      const mobileEnter=e.key==="Enter"&&(window.matchMedia("(max-width: 640px)").matches||navigator.maxTouchPoints>0);
      if(e.key==="Enter"&&(e.altKey||mobileEnter)){
        e.preventDefault();insertTaskEditorBreak(e.currentTarget);e.currentTarget.dispatchEvent(new Event("input",{bubbles:true}));return;
      }
      if(e.key==="Enter"){e.preventDefault();e.currentTarget.blur();}
    });
    if(titleEditor)titleEditor.addEventListener("paste",e=>{
      e.preventDefault();const plain=(e.clipboardData||window.clipboardData).getData("text/plain");
      const sel=window.getSelection();if(!sel||!sel.rangeCount)return;
      const range=sel.getRangeAt(0);range.deleteContents();const frag=document.createDocumentFragment();
      plain.split(/\r?\n/).forEach((line,i)=>{if(i)frag.appendChild(document.createElement("br"));frag.appendChild(document.createTextNode(line));});
      range.insertNode(frag);sel.collapseToEnd();e.currentTarget.dispatchEvent(new Event("input",{bubbles:true}));
    });
    if(titleEditor){
      titleEditor.addEventListener("pointerdown",e=>{if(e.target.closest('.card-tools'))return;card.draggable=false;e.stopPropagation();});
      titleEditor.addEventListener("focus",()=>{card.draggable=false;});
      titleEditor.addEventListener("blur",()=>{card.draggable=true;});
      titleEditor.draggable=false;titleEditor.addEventListener("dragstart",e=>e.preventDefault());
    }
    card.querySelector('[data-action="notes"]').oninput=e=>{
      t.notes=e.target.value; save();
    };
    const syncToggleText=()=>{
      const parsed=parseToggleList(t.text);if(!parsed)return;
      const rows=[...card.querySelectorAll(".toggle-list-row")];
      const colorInfo=parseColorSyntax(t.text);
      const listTitle=parsed.title&&parsed.title!=="Checklist"?parsed.title:"";
      const listSource="++++"+(listTitle?" "+listTitle+" ////":"")+"\n"+rows.map(row=>{
        const checked=row.querySelector('[data-action="toggle-item"]').checked;
        const label=row.querySelector('[data-action="edit-item"]').value;
        return (checked?"[x] ":"[ ] ")+label;
      }).join("\n")+"\n++++";
      t.text=colorInfo.name?withColorSyntax(listSource,colorInfo.name):listSource;
      save();
    };
    bindToggleRowControls(card,t,syncToggleText);
    card.addEventListener("input",e=>{
      if(e.target.matches('[data-action="toggle-list-title"],[data-action="edit-item"]'))syncToggleText();
    });
    card.addEventListener("change",e=>{
      if(e.target.matches('[data-action="toggle-item"],[data-action="edit-item"],[data-action="toggle-list-title"]'))syncToggleText();
    });
    card.querySelectorAll('[data-action="move-later"]').forEach(btn=>{
      btn.onclick=e=>{
        e.stopPropagation();
        t.zone=t.zone==="later"?"today":"later";save();render();
        toast(t.zone==="later"?"Moved to Not Today":"Moved to Today");
      };
    });
    card.querySelector('[data-action="delete"]').onclick=()=>{
      const deletedZone=t.zone==="later"?"Not Today":"Today";
      state.tasks=state.tasks.filter(x=>x.id!==tid);save();render();
      toast("Deleted from "+deletedZone+" 🗑️");
    };
    card.querySelector('[data-action="insert-below"]').onclick=e=>{
      e.stopPropagation();
      const index=state.tasks.findIndex(x=>x.id===tid);
      const blank={id:id(),text:"",notes:"",zone:t.zone,done:false,open:false,created:Date.now()};
      state.tasks.splice(index+1,0,blank);save();render();
      const newCard=document.querySelector(`.card[data-id="${blank.id}"]`);
      const next=newCard?.querySelector('[data-action="title"]');
      const newPlus=newCard?.querySelector('[data-action="insert-below"]');
      if(newCard)newCard.classList.add("just-added");
      if(newPlus)newPlus.classList.add("fade-after-click");
      if(next)focusTaskEditor(next);
      toast("Added empty box ✨");
    };
  });

}

function bindDnD(){
  document.querySelectorAll(".card,.section-header-card").forEach(card=>{
    card.addEventListener("dragstart",e=>{
      if(e.target.closest('input,textarea,button,select,[contenteditable="true"]')&&!card.classList.contains("section-header-card")){e.preventDefault();return;}
      window.dragTaskId=card.dataset.id;
      e.dataTransfer.setData("text/plain",card.dataset.id);
      e.dataTransfer.effectAllowed="move";
      card.classList.add("dragging");
    });

    card.addEventListener("dragend",()=>{
      card.classList.remove("dragging");
      document.querySelectorAll(".card,.section-header-card").forEach(c=>c.classList.remove("drop-target"));
    });

    card.addEventListener("dragover",e=>{
      e.preventDefault();
      if(window.dragTaskId && window.dragTaskId!==card.dataset.id){
        const dragged=state.tasks.find(t=>t.id===window.dragTaskId);
        const target=state.tasks.find(t=>t.id===card.dataset.id);
        if(dragged && target &&
           (dragged.zone==="later") === (target.zone==="later")){
          card.classList.add("drop-target");
          e.dataTransfer.dropEffect="move";
        }
      }
    });

    card.addEventListener("dragleave",()=>{
      card.classList.remove("drop-target");
    });

    card.addEventListener("drop",e=>{
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove("drop-target");

      const dragId=e.dataTransfer.getData("text/plain");
      const targetId=card.dataset.id;
      if(dragId && dragId!==targetId){
        moveTaskBefore(dragId,targetId);
      }
    });
  });

  document.querySelectorAll(".cards").forEach(zone=>{
    zone.addEventListener("dragover",e=>{e.preventDefault();zone.classList.add("dragover")});
    zone.addEventListener("dragleave",()=>zone.classList.remove("dragover"));
    zone.addEventListener("drop",e=>{
      e.preventDefault();zone.classList.remove("dragover");
      const t=state.tasks.find(x=>x.id===e.dataTransfer.getData("text/plain"));
      if(t){
        t.zone=zone.dataset.zone;
        save();render();
        toast(zone.dataset.zone==="later"?"Moved to Not Today":"Moved to Today");
      }
    });
  });
}

function moveSelectedAbove(){
  if(!selectedTaskIds.size){toast("Select at least one task");return;}
  const zone=document.getElementById("moveTargetZone").value;
  const target=Number(document.getElementById("moveAboveNumber").value);
  const destination=state.tasks.filter(t=>(t.zone==="later"?"later":"today")===zone);
  const selected=state.tasks.filter(t=>selectedTaskIds.has(t.id));
  if(!selected.length){toast("Select at least one task");return;}
  const selectedInDestination=selected.filter(t=>(t.zone==="later"?"later":"today")===zone).length;
  const max=Math.max(1,destination.length-selectedInDestination+1);
  if(!Number.isInteger(target)||target<1||target>max){toast(`Choose a position from 1 to ${max}`);updateMoveRange();return;}
  const selectedIds=new Set(selected.map(t=>t.id));
  const moving=state.tasks.filter(t=>selectedIds.has(t.id));
  const rest=state.tasks.filter(t=>!selectedIds.has(t.id));
  moving.forEach(t=>t.zone=zone);
  const destinationRest=rest.filter(t=>(t.zone==="later"?"later":"today")===zone);
  const insertIndex=Math.min(target-1,destinationRest.length);
  destinationRest.splice(insertIndex,0,...moving);
  const otherZoneTasks=rest.filter(t=>(t.zone==="later"?"later":"today")!==zone);
  state.tasks=[...destinationRest,...otherZoneTasks];
  save();render();toast(`${moving.length} task${moving.length===1?"":"s"} moved to ${zone==="today"?"Today":"Not Today"} · position ${target}`);
}

function applyColorToSelected(){
  const ids=[...selectedTaskIds];
  if(!ids.length){toast("Select task checkboxes first");return;}
  const picker=document.getElementById("selectedColor");
  const colorName=picker?.value;
  if(!colorName || !TASK_COLORS[colorName]){toast("Choose a colour first");return;}
  let changed=0;
  state.tasks.forEach(t=>{
    if(!selectedTaskIds.has(t.id))return;
    const parsed=parseColorSyntax(t.text);
    t.text=withColorSyntax(parsed.body,colorName);
    t.colorHex=TASK_COLORS[colorName];
    t.textColorHex=TASK_TEXT_COLORS[colorName];
    t.colorName=colorName;
    changed++;
  });
  if(!changed){toast("No selected tasks found");return;}
  save();render();toast(`🎨 ${changed} task${changed===1?"":"s"} coloured ${colorName}`);
}
function removeColorFromSelected(){
  if(!selectedTaskIds.size){toast("Select at least one task");return;}
  state.tasks.forEach(t=>{
    if(!selectedTaskIds.has(t.id))return;
    const parsed=parseColorSyntax(t.text);
    t.text=parsed.body;
    delete t.colorHex;delete t.textColorHex;delete t.colorName;
  });
  save();render();toast("Color removed from selected tasks");
}
function clearCompleted(){
  const before=state.tasks.length;
  let removedItems=0;
  state.tasks=state.tasks.filter(t=>t.isHeader||!t.done);
  state.tasks.forEach(t=>{
    const parsed=parseToggleList(t.text);
    if(!parsed)return;
    const remaining=parsed.filter(item=>{
      if(item.done){removedItems++;return false;}
      return true;
    });
    if(remaining.length!==parsed.length){
      const colorInfo=parseColorSyntax(t.text);
      const title=parsed.title;
      const rebuilt="++++ "+title+" ////\n"+remaining.map(item=>"[ ] "+item.text).join("\n")+"\n++++";
      t.text=colorInfo.name?withColorSyntax(rebuilt,colorInfo.name):rebuilt;
    }
  });
  const removedTasks=before-state.tasks.length;
  save();render();
  const total=removedTasks+removedItems;
  toast(total+" completed item"+(total===1?"":"s")+" cleared 🧹");
}

function exportData(){
  const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="daily-sort-backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

function importData(file){
  const r=new FileReader();
  r.onload=()=>{
    try{
      const x=JSON.parse(r.result);
      if(!Array.isArray(x.tasks))throw Error();
      state={tasks:x.tasks};state.tasks.forEach(t=>{delete t.groupId;if(!t.zone)t.zone="today";if(!("notes" in t))t.notes="";if(!("open" in t))t.open=false;});save();render();toast("Imported");
    }catch(e){toast("Invalid backup file")}
  };
  r.readAsText(file);
}

const THEMES={
  "Paper":{"bg":"#f7f5f0","panel":"#fffdf9","line":"#e4ded4","text":"#171513","muted":"#746e65","accent":"#4d8f70","accentSoft":"#e3f1e9"},
  "Forest":{"bg":"#eef4ec","panel":"#fbfdf9","line":"#cfdccc","text":"#1d2c1e","muted":"#687568","accent":"#4f8a54","accentSoft":"#e2f0e2"},
  "Lavender":{"bg":"#f4f0fa","panel":"#fdfbff","line":"#ddd2ea","text":"#282039","muted":"#766b85","accent":"#8064a8","accentSoft":"#eee7f7"},
  "Rose":{"bg":"#fbf0f2","panel":"#fffafb","line":"#ead1d6","text":"#321d23","muted":"#80666d","accent":"#b45d72","accentSoft":"#f6e2e7"},
  "Solarized":{"bg":"#fdf6e3","panel":"#fffaf0","line":"#eee8d5","text":"#073642","muted":"#657b83","accent":"#268bd2","accentSoft":"#e1f0fb"},
  "Soft Bloom":{"bg":"#f5f2ff","panel":"#fffefe","line":"#e0d8f3","text":"#30264a","muted":"#766a91","accent":"#9273d6","accentSoft":"#eee8ff"},
  "Sandstone":{"bg":"#f3eee5","panel":"#fcf8ef","line":"#ddd0bd","text":"#382d20","muted":"#85745e","accent":"#a56f37","accentSoft":"#f0e2cf"},
  "Dracula":{"bg":"#282a36","panel":"#343746","line":"#494c5e","text":"#f8f8f2","muted":"#b8b8c6","accent":"#bd93f9","accentSoft":"#403450"},
  "Gruvbox":{"bg":"#282828","panel":"#32302f","line":"#504945","text":"#ebdbb2","muted":"#a89984","accent":"#b8bb26","accentSoft":"#3b421d"},
  "Cyber":{"bg":"#080b10","panel":"#101722","line":"#263344","text":"#d9f7ff","muted":"#7da0ad","accent":"#00d9ff","accentSoft":"#082d36"},
  "Terminal":{"bg":"#071107","panel":"#0d190d","line":"#1d351d","text":"#b7ffb7","muted":"#6aa56a","accent":"#39d86c","accentSoft":"#10351b"},
  "Midnight":{"bg":"#101114","panel":"#17191d","line":"#2a2d33","text":"#f2f3f5","muted":"#a4a8b0","accent":"#78c7a0","accentSoft":"#193327"},
  "AMOLED":{"bg":"#000000","panel":"#080808","line":"#222222","text":"#ffffff","muted":"#929292","accent":"#00e676","accentSoft":"#062b18"},
  "Plum":{"bg":"#241b28","panel":"#302333","line":"#4c384f","text":"#f5e8f2","muted":"#bba7b7","accent":"#d78bc1","accentSoft":"#4b2f45"},

  "Water Ocean":{"bg":"#eaf8fb","panel":"#f8feff","line":"#b9e0e9","text":"#103743","muted":"#547d88","accent":"#159bb3","accentSoft":"#d7f2f6"},
  "Blue Blue Sky":{"bg":"#edf6ff","panel":"#fbfdff","line":"#c9def2","text":"#172f4a","muted":"#647f9b","accent":"#438bd8","accentSoft":"#deedff"},
  "Holi":{"bg":"#fff5fb","panel":"#fffaff","line":"#f0dbe9","text":"#3c2940","muted":"#846f83","accent":"#b95f9b","accentSoft":"#f7e7f2"},
  "Dasain":{"bg":"#fff6ef","panel":"#fffdf9","line":"#ecdcc9","text":"#3d2d25","muted":"#866f60","accent":"#ad6147","accentSoft":"#f5e7d9"},
  "Gradient Light":{"bg":"#f4f2fa","panel":"#fcfbff","line":"#dcd9ea","text":"#28243a","muted":"#77718c","accent":"#7f75c7","accentSoft":"#e9e6f8"},
  "Cloud Drift":{"bg":"#eef7ff","panel":"#fbfdff","line":"#cbdff0","text":"#1e3448","muted":"#657e92","accent":"#5a9fcf","accentSoft":"#e0effb"},
  "Meadow Breeze":{"bg":"#eff8ef","panel":"#fbfef9","line":"#cfe3cf","text":"#203a27","muted":"#6c876f","accent":"#5d9a68","accentSoft":"#e1f1e2"},
  "Rainy Window":{"bg":"#eaf1f8","panel":"#f8fbff","line":"#cbd8e8","text":"#24364a","muted":"#6d8198","accent":"#5b91c8","accentSoft":"#dceafb"},
  "Diwali":{"bg":"#17101f","panel":"#281b31","line":"#574064","text":"#f5e9d8","muted":"#bda98e","accent":"#d99a38","accentSoft":"#50331b"},
  "Christmas":{"bg":"#10201b","panel":"#1a3028","line":"#365a4b","text":"#effbf1","muted":"#a8c6b4","accent":"#cf6570","accentSoft":"#3b292c"},
  "Northern Lights":{"bg":"#081b25","panel":"#102a35","line":"#28515b","text":"#e1fff7","muted":"#8ebbb9","accent":"#55cdb9","accentSoft":"#15443f"},
  "Strobe Lights":{"bg":"#141322","panel":"#201d31","line":"#3e395b","text":"#eeeaff","muted":"#aaa4c8","accent":"#8c80dc","accentSoft":"#35304f"},
  "Gradient Dark":{"bg":"#111323","panel":"#1b1e34","line":"#3d4267","text":"#f1f0ff","muted":"#aaaed0","accent":"#8b8be2","accentSoft":"#30345c"},
  "Ember Glow":{"bg":"#211613","panel":"#30201b","line":"#55382e","text":"#fff0e6","muted":"#c3a493","accent":"#df8755","accentSoft":"#4a2b25"},
  "Moonlit":{"bg":"#101827","panel":"#1b273b","line":"#344864","text":"#edf5ff","muted":"#9dafc8","accent":"#83a8da","accentSoft":"#293e5b"}
};
const THEME_MOTION={"Water Ocean":"ocean","Blue Blue Sky":"sky","Holi":"holi","Dasain":"dasain","Gradient Light":"gradient-light","Meadow Breeze":"meadow","Rainy Window":"rain","Diwali":"diwali","Christmas":"holiday","Northern Lights":"northernlights","Strobe Lights":"strobe","Gradient Dark":"gradient-dark","Ember Glow":"ember","Moonlit":"moonlit"};
const THEME_ALIASES={"Ocean":"Water Ocean","Slate":"Blue Blue Sky","Nord":"Blue Blue Sky","Paper Blue":"Blue Blue Sky","Paper Green":"Forest","Monochrome":"Paper","Aurora":"Northern Lights","Neon Nights":"Strobe Lights","Deep Sea":"Water Ocean","Rainbow":"Gradient Dark","Gradients":"Gradient Dark"};
const encoder=new TextEncoder();
function bytesToB64(bytes){let s="";bytes.forEach(b=>s+=String.fromCharCode(b));return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
function b64ToBytes(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";const bin=atob(s);return Uint8Array.from(bin,c=>c.charCodeAt(0));}
function randomToken(){const a=new Uint8Array(24);crypto.getRandomValues(a);return bytesToB64(a);}
function hexToHsl(hex){
  const raw=hex.replace('#','');const full=raw.length===3?raw.split('').map(c=>c+c).join(''):raw;
  const [r0,g0,b0]=full.match(/.{2}/g).map(v=>parseInt(v,16)/255);const max=Math.max(r0,g0,b0),min=Math.min(r0,g0,b0);let h=0,s=0,l=(max+min)/2;
  if(max!==min){const d=max-min;s=l>.5?d/(2-max-min):d/(max+min);switch(max){case r0:h=(g0-b0)/d+(g0<b0?6:0);break;case g0:h=(b0-r0)/d+2;break;default:h=(r0-g0)/d+4;}h*=60;}
  return [h,s,l];
}
function hslToHex(h,s,l){
  h=((h%360)+360)%360;s=Math.max(0,Math.min(1,s));l=Math.max(0,Math.min(1,l));const c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs((h/60)%2-1)),m=l-c/2;let rgb=[0,0,0];
  if(h<60)rgb=[c,x,0];else if(h<120)rgb=[x,c,0];else if(h<180)rgb=[0,c,x];else if(h<240)rgb=[0,x,c];else if(h<300)rgb=[x,0,c];else rgb=[c,0,x];
  return '#'+rgb.map(v=>Math.round((v+m)*255).toString(16).padStart(2,'0')).join('');
}
function buildDynamicLogoSvg(primary,secondary,shell){
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="14" y1="20" x2="82" y2="78" gradientUnits="userSpaceOnUse"><stop stop-color="${primary}"/><stop offset="1" stop-color="${secondary}"/></linearGradient></defs><rect x="3" y="3" width="90" height="90" rx="25" fill="${shell}"/><path d="M4 65c18-11 31-5 47 5s30 12 45 2v13c-1 5-6 8-12 8H15C8 93 3 87 3 80Z" fill="${primary}" opacity=".18"/><rect x="18" y="22" width="48" height="10" rx="5" fill="url(#g)"/><circle cx="70" cy="27" r="9" fill="${secondary}"/><rect x="17" y="43" width="39" height="10" rx="5" fill="${secondary}"/><rect x="17" y="65" width="29" height="10" rx="5" fill="${primary}"/><path d="m55 68 9 10 18-20" fill="none" stroke="${secondary}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function updateDynamicBrandAssets(primary,secondary,shell,bg){
  const svg=buildDynamicLogoSvg(primary,secondary,shell);const favicon=document.getElementById('dynamicFavicon');
  if(favicon){favicon.href='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);favicon.type='image/svg+xml';}
  const meta=document.getElementById('themeColorMeta');if(meta)meta.content=bg;
  const appName=document.querySelector('meta[name="application-name"]');if(appName)appName.content='Daily Sort';
}
let themeParticleTimer=null,gradientMeshTimer=null;
function refreshThemeParticles(name){
  const host=document.getElementById("themeParticles");if(!host)return;host.innerHTML="";
  const motion=THEME_MOTION[name]||"";
  const make=(cls,opts={})=>{
    const el=document.createElement("span");el.className=cls;
    for(const [k,v] of Object.entries(opts))el.style.setProperty(k,v);
    host.appendChild(el);return el;
  };
  const rand=(a,b)=>a+Math.random()*(b-a);
  if(motion==="sky"||motion==="cloud"){
    const count=motion==="sky"?6:7;
    for(let i=0;i<count;i++){
      make("fx-cloud",{
        "--top":rand(7,78)+"vh","--w":rand(motion==="sky"?150:190,motion==="sky"?280:360)+"px",
        "--h":rand(38,86)+"px","--alpha":rand(motion==="sky"?.34:.2,motion==="sky"?.62:.42),
        "--duration":rand(motion==="sky"?48:65,motion==="sky"?88:110)+"s",
        "--delay":(-rand(0,95))+"s","--drift":rand(115,185)+"vw"
      });
    }
  }
  if(motion==="holi"){
    const colors=["#ff4fa3","#36b9ff","#ffd34e","#59d69a","#a47aff","#ff8154","#ee79df"];
    for(let i=0;i<9;i++){
      const el=make("fx-holi",{
        "--x":rand(2,94)+"vw","--y":rand(5,88)+"vh","--size":rand(110,240)+"px",
        "--duration":rand(22,39)+"s","--delay":(-rand(0,38))+"s","--dx":rand(-100,100)+"px","--dy":rand(-90,90)+"px"
      });el.style.background=`radial-gradient(ellipse at 35% 40%,${colors[i%colors.length]}88 0,${colors[i%colors.length]}45 22%,transparent 70%)`;
    }
  }
  if(motion==="dasain"){
    const symbols=["🍂","🌾","🔴","❤️","🌺","🌾","🍁","🔴"];
    for(let i=0;i<30;i++){
      const el=make("theme-particle",{"--left":rand(0,98)+"vw","--size":rand(15,25)+"px","--alpha":rand(.25,.62),"--duration":rand(18,33)+"s","--delay":(-rand(0,34))+"s","--drift":rand(-150,150)+"px","--spin":rand(-520,520)+"deg"});
      el.textContent=symbols[i%symbols.length];
      if(symbols[i%symbols.length]==="🔴")el.style.filter="drop-shadow(0 0 7px #c31d27aa)";
    }
  }
  if(motion==="diwali"){
    const symbols=["🎆","✨","🎇","🪔","✨","🚀","💥"];
    for(let i=0;i<16;i++){
      const el=make("theme-particle",{"--left":rand(3,97)+"vw","--size":rand(14,25)+"px","--alpha":rand(.18,.42),"--duration":rand(5,10)+"s","--delay":(-rand(0,10))+"s","--drift":rand(-90,90)+"px","--spin":rand(-220,220)+"deg","--top":rand(12,75)+"vh"});
      el.textContent=symbols[i%symbols.length];el.classList.add("fx-firework");
    }
  }
  if(motion==="holiday"){
    for(let i=0;i<34;i++){
      const el=make("theme-particle",{"--left":rand(0,99)+"vw","--size":rand(5,10)+"px","--alpha":rand(.25,.6),"--duration":rand(16,28)+"s","--delay":(-rand(0,28))+"s","--drift":rand(-70,70)+"px","--spin":rand(-90,90)+"deg"});el.textContent="❄";
    }
  }
  if(motion==="ocean"){
    for(let i=0;i<5;i++)make("fx-wave",{"--level":(i*7+4)+"vh","--duration":rand(12,19)+"s","--delay":(-rand(0,18))+"s","--drift":(i%2?"-":"")+rand(45,115)+"px","--alpha":rand(.12,.25)});
  }
  if(motion==="ember"){
    for(let i=0;i<11;i++)make("fx-ember",{"--x":rand(3,97)+"vw","--y":rand(28,110)+"vh","--size":rand(70,190)+"px","--duration":rand(9,18)+"s","--delay":(-rand(0,18))+"s","--rise":rand(16,35)+"vh","--alpha":rand(.12,.3)});
  }
  if(motion==="moonlit"){
    make("fx-moon");make("fx-moonbeam");
    for(let i=0;i<48;i++)make("fx-star",{"--x":rand(2,98)+"vw","--y":rand(3,75)+"vh","--delay":(-rand(0,5))+"s","--duration":rand(2.6,5.8)+"s","--alpha":rand(.25,.75)});
  }
  if(motion==="meadow"){
    const symbols=["🍃","✿","🌿"];
    for(let i=0;i<18;i++){const el=make("theme-particle",{"--left":rand(0,99)+"vw","--size":rand(13,22)+"px","--alpha":rand(.12,.3),"--duration":rand(20,35)+"s","--delay":(-rand(0,35))+"s","--drift":rand(-120,120)+"px","--spin":rand(-300,300)+"deg"});el.textContent=symbols[i%symbols.length];}
  }
}
function randomMeshColor(dark){const h=Math.floor(Math.random()*360);const s=dark?65+Math.random()*25:58+Math.random()*26;const l=dark?42+Math.random()*25:62+Math.random()*26;return `hsla(${h},${s}%,${l}%,.82)`;}
function updateGradientMesh(){const dark=document.documentElement.dataset.themeDark==="true";const root=document.documentElement;["a","b","c","d"].forEach(k=>root.style.setProperty(`--mesh-${k}`,randomMeshColor(dark)));}
function startGradientMesh(name){if(gradientMeshTimer){clearInterval(gradientMeshTimer);gradientMeshTimer=null;}if(name==="Gradient Light"||name==="Gradient Dark"){updateGradientMesh();gradientMeshTimer=setInterval(()=>{if(document.visibilityState!=="hidden")updateGradientMesh();},1800);}}
function applyTheme(name, sync=true){
  name=THEME_ALIASES[name]||name;const t=THEMES[name]||THEMES.Paper;const r=document.documentElement;
  const hex=t.bg.replace('#','');const rgb=hex.length===3?hex.split('').map(x=>parseInt(x+x,16)):hex.match(/.{2}/g).map(x=>parseInt(x,16));
  const luminance=(0.2126*rgb[0]+0.7152*rgb[1]+0.0722*rgb[2])/255;const isDark=luminance<0.48;
  const [h,s]=hexToHsl(t.accent);const secondary=hslToHex(h+154,Math.max(.68,s),isDark ? 0.62 : 0.48);
  const shell=isDark?t.panel:'#101f32';const wave=isDark?t.bg:'#1b3b54';
  r.style.colorScheme=isDark?'dark':'light';r.dataset.themeDark=isDark?'true':'false';
  r.style.setProperty('--bg',t.bg);r.style.setProperty('--panel',t.panel);r.style.setProperty('--line',t.line);r.style.setProperty('--text',t.text);r.style.setProperty('--muted',t.muted);r.style.setProperty('--accent',t.accent);r.style.setProperty('--accent-soft',t.accentSoft);
  r.style.setProperty('--input',t.input||t.panel);r.style.setProperty('--button',t.button||t.panel);r.style.setProperty('--card',t.card||t.panel);r.style.setProperty('--details',t.details||t.panel);r.style.setProperty('--soft',t.soft||t.accentSoft);r.style.setProperty('--later-bg',t.laterBg||t.panel);r.style.setProperty('--later-head',t.laterHead||t.panel);r.style.setProperty('--red',t.red||'#b56b67');
  r.style.setProperty('--logo-primary',t.accent);r.style.setProperty('--logo-secondary',secondary);r.style.setProperty('--logo-shell',shell);r.style.setProperty('--logo-wave',wave);
  r.style.setProperty('--danger-bg',isDark?'#641f2b':'#ffe6e9');r.style.setProperty('--danger-text',isDark?'#ffb8c2':'#8b1e2d');r.style.setProperty('--danger-border',isDark?'#b64a5c':'#e8a2ad');
  r.style.setProperty('--zone-arrow-bg',isDark?'#e4f5ff':'#17364f');r.style.setProperty('--zone-arrow-fg',isDark?'#102a3e':'#f2faff');r.style.setProperty('--zone-arrow-border',isDark?'#9bcbe5':'#315b78');r.style.setProperty('--zone-arrow-hover',isDark?'#b9e9ff':'#285c80');r.style.setProperty('--zone-arrow-hover-fg',isDark?'#0b2637':'#ffffff');
  document.body.dataset.activeTheme=name;document.body.dataset.themeMotion=THEME_MOTION[name]||'';localStorage.setItem(THEME_KEY,name);
  document.querySelectorAll('.theme-btn').forEach(b=>b.classList.toggle('active',b.dataset.theme===name));
  updateDynamicBrandAssets(t.accent,secondary,shell,t.bg);refreshThemeParticles(name);startGradientMesh(name);if(sync)queueCloudSave();
}
const STATIC_THEME_GROUPS={
  "Light":["Paper","Forest","Lavender","Rose","Solarized","Soft Bloom","Sandstone"],
  "Dark":["Dracula","Gruvbox","Cyber","Terminal","Midnight","AMOLED","Plum"]
};
const LIVE_THEME_GROUPS={
  "Light":["Water Ocean","Blue Blue Sky","Holi","Dasain","Gradient Light","Meadow Breeze","Rainy Window"],
  "Dark":["Diwali","Christmas","Northern Lights","Strobe Lights","Gradient Dark","Ember Glow","Moonlit"]
};
function themeButtons(names){return names.map(n=>`<button class="theme-btn ds-theme-btn" data-theme="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join("");}
function renderThemes(){
 const grid=document.getElementById("themeGrid");
 const family=(title,groups)=>`<section class="ds-theme-family"><h4>${title}</h4><div class="ds-theme-pair">${Object.entries(groups).map(([mode,names])=>`<div class="ds-theme-mode"><h5>${mode}</h5><div class="ds-theme-grid">${themeButtons(names)}</div></div>`).join("")}</div></section>`;
 grid.innerHTML=family("🧊 Static themes",STATIC_THEME_GROUPS)+family("✨ Live themes",LIVE_THEME_GROUPS);
 grid.querySelectorAll(".ds-theme-btn").forEach(b=>b.onclick=()=>applyTheme(b.dataset.theme));
 applyTheme(localStorage.getItem(THEME_KEY)||"Paper",false);
}
const derivedKeyCache=new Map();
async function deriveV2Key(token,salt){
  const cacheKey="v2:"+token+":"+bytesToB64(salt);
  if(derivedKeyCache.has(cacheKey))return derivedKeyCache.get(cacheKey);
  const promise=(async()=>{
    const base=await crypto.subtle.importKey("raw",encoder.encode(token),"HKDF",false,["deriveKey"]);
    return crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",salt,info:encoder.encode("Daily Sort session encryption v2")},base,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  })();
  derivedKeyCache.set(cacheKey,promise);
  try{return await promise}catch(e){derivedKeyCache.delete(cacheKey);throw e}
}
async function deriveLegacyKey(token,salt){
  const cacheKey="v1:"+token;
  if(derivedKeyCache.has(cacheKey))return derivedKeyCache.get(cacheKey);
  const promise=(async()=>{
    const base=await crypto.subtle.importKey("raw",encoder.encode(token),"PBKDF2",false,["deriveKey"]);
    return crypto.subtle.deriveKey({name:"PBKDF2",salt,iterations:180000,hash:"SHA-256"},base,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  })();
  derivedKeyCache.set(cacheKey,promise);
  try{return await promise}catch(e){derivedKeyCache.delete(cacheKey);throw e}
}
function getSessionToken(){
  let t="";
  try{
    t=localStorage.getItem(SESSION_KEY)||"";
    if(!t.trim()){
      const legacyKeys=["daily-sort-session","dailySortSessionToken","daily-sort-token","daily-sort-session-token"];
      for(const key of legacyKeys){
        const candidate=localStorage.getItem(key);
        if(candidate&&candidate.trim()){t=candidate.trim();break;}
      }
    }
    if(!t.trim()){
      t=randomToken();
      localStorage.setItem(SESSION_KEY,t);
    }else{
      localStorage.setItem(SESSION_KEY,t);
    }
  }catch(e){console.error("Daily Sort could not read/write its session token",e)}
  return t;
}
async function legacySalt(token){const b=await crypto.subtle.digest("SHA-256",encoder.encode(LEGACY_SESSION_SALT_PREFIX+token));return new Uint8Array(b).slice(0,16)}
async function encryptState(token,obj){
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const key=await deriveV2Key(token,salt);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const plain=encoder.encode(JSON.stringify(obj));
  const cipher=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,plain));
  return JSON.stringify({v:2,kdf:"HKDF-SHA-256",cipher:"AES-256-GCM",salt:bytesToB64(salt),iv:bytesToB64(iv),data:bytesToB64(cipher)});
}
async function decryptState(token,payload){
  const x=typeof payload==="string"?JSON.parse(payload):payload;
  let key;
  if(x?.v===2 && x.salt){key=await deriveV2Key(token,b64ToBytes(x.salt));}
  else {const salt=await legacySalt(token);key=await deriveLegacyKey(token,salt);}
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:b64ToBytes(x.iv)},key,b64ToBytes(x.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function setupRealtime(token=getSessionToken()){
  await ensureSupabase();
  if(realtimeToken===token && realtimeChannel)return;
  if(realtimeChannel){try{await sb.removeChannel(realtimeChannel);}catch(e){}}
  realtimeChannel=null;realtimeToken=token;
  const digest=await crypto.subtle.digest("SHA-256",encoder.encode("daily-sort-channel:"+token));
  const channelId=Array.from(new Uint8Array(digest).slice(0,12)).map(b=>b.toString(16).padStart(2,"0")).join("");
  realtimeChannel=sb.channel("daily-sort-live-"+channelId,{config:{broadcast:{self:false}}})
    .on("broadcast",{event:"deleted"},async()=>{await rotateRevokedSessionOnThisDevice(token,"This session was deleted remotely");})
    .on("broadcast",{event:"state"},async({payload})=>{
      if(!payload?.encrypted || applyingRemote)return;
      try{
        const remote=await decryptState(token,payload.encrypted);
        const remoteState=remote?.state||remote;
        if(!Array.isArray(remoteState?.tasks))return;
        applyingRemote=true;
        state={tasks:remoteState.tasks};
        if(typeof remote?.draft === "string"){const box=document.getElementById("bulkInput");if(box && document.activeElement!==box){box.value=remote.draft;try{localStorage.setItem(DRAFT_KEY,remote.draft)}catch(e){}}}
        state.tasks.forEach(t=>{delete t.groupId;if(!t.zone)t.zone="today";if(!("notes" in t))t.notes="";if(!("open" in t))t.open=false;});
        localStorage.setItem(STORAGE,JSON.stringify(state));
        if(remote?.theme&&THEMES[remote.theme])applyTheme(remote.theme,false);
        render();
        updateCloudStatus("Cloud: live · synced from another device");
      }catch(err){console.warn("Live update could not be applied",err)}
      finally{applyingRemote=false;}
    })
    .subscribe(status=>{
      if(status==="SUBSCRIBED")updateCloudStatus("Cloud: live · devices connected");
    });
}

async function pullCloud(tokenOverride=null){
  const token=tokenOverride||getSessionToken();
  await ensureSupabase();
  updateCloudStatus("Cloud: connecting…");
  try{
    const {data,error}=await sb.rpc("daily_sort_get_session",{p_token:token});
    if(error) throw error;
    if(data){
      const payload=typeof data === "string" ? JSON.parse(data) : data;
      if(payload && payload.iv && payload.data){
        const remote=await decryptState(token,payload);
        const remoteState=remote?.state || remote;
        if(!Array.isArray(remoteState?.tasks)) throw new Error("Invalid session data");
        const importedState={tasks:remoteState.tasks};
        if(typeof remote?.draft === "string"){const box=document.getElementById("bulkInput");if(box){box.value=remote.draft;try{localStorage.setItem(DRAFT_KEY,remote.draft)}catch(e){}}}
        importedState.tasks.forEach(t=>delete t.groupId);
        if(remote?.theme && THEMES[remote.theme]) applyTheme(remote.theme,false);
        state=importedState;
        localStorage.setItem(STORAGE,JSON.stringify(state));
        render();
        cloudReady=true;
        updateCloudStatus("Cloud: connected — imported session");
        toast("Session restored");
        return true;
      }
    }
    cloudReady=true;
    const created=await pushCloud(token);
    if(!created){await new Promise(resolve=>setTimeout(resolve,80));if(getSessionToken()!==token)return true;}
    updateCloudStatus(created?"Cloud: connected":"Cloud: unavailable — local session preserved");
    return !!created;
  }catch(e){
    console.warn("Daily Sort cloud sync unavailable",e);
    updateCloudStatus("Cloud: unavailable — local session preserved");
    return false;
  }
}
async function pushCloud(tokenOverride=null){
  let token=tokenOverride||getSessionToken();
  try{await ensureSupabase()}catch(err){updateCloudStatus("Cloud: unavailable · "+err.message);return false;}
  if(syncingCloud){
    return false;
  }
  syncingCloud=true;
  const changeSnapshot=localChangeAt;
  try{
    const payload={
      state:JSON.parse(JSON.stringify(state)),
      draft:document.getElementById("bulkInput")?.value||"",
      theme:localStorage.getItem(THEME_KEY)||"Paper"
    };
    const encrypted=await encryptState(token,payload);
    if(realtimeChannel && !applyingRemote){
      try{
        await realtimeChannel.send({type:"broadcast",event:"state",payload:{encrypted,at:Date.now()}});
      }catch(broadcastError){console.warn("Live broadcast failed",broadcastError)}
    }
    const {error}=await sb.rpc("daily_sort_save_session",{p_token:token,p_data:JSON.parse(encrypted)});
    if(error) throw error;
    return true;
  }catch(e){console.warn("Daily Sort cloud save failed",e);if(/revoked|deleted session/i.test(String(e?.message||e))){const revokedToken=token;setTimeout(()=>rotateRevokedSessionOnThisDevice(revokedToken,"This session was deleted remotely"),0);}return false}
  finally{
    syncingCloud=false;
    if(cloudReady && localChangeAt>changeSnapshot)queueCloudSave();
  }
}
function queueCloudSave(){
  if(!cloudReady || applyingRemote)return;
  clearTimeout(cloudTimer);
  cloudTimer=setTimeout(()=>pushCloud(),50);
}
function updateCloudStatus(msg){const el=document.getElementById("cloudStatus");if(el)el.textContent=msg;}
function openSession(){
  const x=document.getElementById("sessionToken");
  x.value=localStorage.getItem(SESSION_KEY)||getSessionToken();
  document.getElementById("sessionModal").classList.add("show");
  renderThemes();
}
function closeSession(){document.getElementById("sessionModal").classList.remove("show");}

function toast(msg){
  const base=document.getElementById("toast");
  if(!base)return;
  const el=base.cloneNode(false);
  el.removeAttribute("id");el.textContent=msg;
  const existing=[...document.querySelectorAll(".toast.transient")];
  el.classList.add("transient");
  el.style.bottom=(22+existing.length*48)+"px";
  document.body.appendChild(el);
  requestAnimationFrame(()=>el.classList.add("show"));
  setTimeout(()=>{el.classList.remove("show");setTimeout(()=>el.remove(),180);},msg.startsWith("Token copied")?950:1450);
}

document.getElementById("addToday").onclick=()=>addTasksFromText("today");
document.getElementById("addLater").onclick=()=>addTasksFromText("later");
document.getElementById("dumpToday").onclick=()=>dumpZone("today");
document.getElementById("dumpLater").onclick=()=>dumpZone("later");
document.getElementById("bulkInput").addEventListener("keydown",e=>{
  if((e.ctrlKey||e.metaKey)&&e.key==="Enter"){
    e.preventDefault();
    addTasksFromText(e.shiftKey?"later":"today");
  }
});
document.getElementById("clearCompleted").onclick=clearCompleted;
document.getElementById("taskSearch").addEventListener("input",()=>render());
document.getElementById("deleteSelected").onclick=()=>{
  if(!selectedTaskIds.size)return;
  const count=selectedTaskIds.size;
  if(!window.confirm(`Delete ${count} selected task${count===1?"":"s"}? This cannot be undone from the task list.`))return;
  state.tasks=state.tasks.filter(t=>!selectedTaskIds.has(t.id));
  selectedTaskIds.clear();save();render();toast(`🗑️ Deleted ${count} selected task${count===1?"":"s"}`);
};
document.getElementById("exportData").onclick=exportData;
document.getElementById("importBtn").onclick=()=>document.getElementById("importFile").click();
document.getElementById("importFile").onchange=e=>{if(e.target.files[0])importData(e.target.files[0]);e.target.value=""};
document.getElementById("sessionBtn").onclick=openSession;
document.getElementById("sessionFooter").onclick=openSession;
document.getElementById("closeSession").onclick=closeSession;
document.getElementById("sessionModal").onclick=e=>{if(e.target.id==="sessionModal")closeSession()};
document.getElementById("revealToken").onclick=()=>{const x=document.getElementById("sessionToken");x.type=x.type==="password"?"text":"password";document.getElementById("revealToken").textContent=x.type==="password"?"Show":"Hide"};
document.getElementById("copyToken").onclick=async()=>{try{await navigator.clipboard.writeText(getSessionToken());toast("Token copied ✅")}catch(e){toast("Could not copy token — check clipboard permission")}};
const deletePrankOverlay=document.getElementById("deletePrankOverlay");
const deletePrankRain=document.getElementById("deletePrankRain");
const deletePrankDialog=document.getElementById("deletePrankDialog");
const kissScreen=document.getElementById("kissScreen");
const deleteFinalConfirm=document.getElementById("deleteFinalConfirm");
let deletePrankTimers=[];
function clearDeletePrankTimers(){deletePrankTimers.forEach(clearTimeout);deletePrankTimers=[];}
function closeDeletePrank(){
  clearDeletePrankTimers();
  deletePrankOverlay.hidden=true;deletePrankDialog.hidden=true;kissScreen.hidden=true;deleteFinalConfirm.hidden=true;
  deletePrankRain.innerHTML="";document.getElementById("deleteFinalWord").value="";document.getElementById("executeFinalDelete").disabled=true;
  const flood=document.getElementById("deleteFlood"),label=document.getElementById("deleteFloodLabel");
  if(flood)flood.classList.remove("flooding","retreat");if(label)label.classList.remove("visible");
}
function makePrankRain(symbols,count=46){
  deletePrankRain.innerHTML="";
  for(let i=0;i<count;i++){
    const piece=document.createElement("span");piece.className="prank-rain-piece";piece.textContent=symbols[i%symbols.length];
    piece.style.setProperty("--x",(Math.random()*100)+"vw");piece.style.setProperty("--delay",(Math.random()*1.15)+"s");piece.style.setProperty("--duration",(1.45+Math.random()*1.5)+"s");piece.style.setProperty("--drift",((Math.random()-.5)*180)+"px");piece.style.setProperty("--spin",((Math.random()-.5)*900)+"deg");deletePrankRain.appendChild(piece);
  }
}
function beginDeletePrank(){
  clearDeletePrankTimers();
  deletePrankOverlay.hidden=false;deletePrankDialog.hidden=true;kissScreen.hidden=true;deleteFinalConfirm.hidden=true;deletePrankRain.hidden=false;
  document.getElementById("deleteFinalWord").value="";document.getElementById("executeFinalDelete").disabled=true;
  makePrankRain(["🚨","🔔","💥","🧨","💣","🚨"],52);
  deletePrankTimers.push(setTimeout(()=>{deletePrankDialog.hidden=false;deletePrankDialog.querySelector(".prank-siren").textContent="🚨 🔔 💥";},1700));
}
function showFinalDeleteConfirmation(){
  deletePrankDialog.hidden=true;deletePrankRain.hidden=true;
  const flood=document.getElementById("deleteFlood"),label=document.getElementById("deleteFloodLabel");
  flood.classList.remove("retreat");flood.classList.add("flooding");
  clearDeletePrankTimers();
  deletePrankTimers.push(setTimeout(()=>label.classList.add("visible"),5300));
  deletePrankTimers.push(setTimeout(()=>{label.classList.remove("visible");flood.classList.add("retreat");},7600));
  deletePrankTimers.push(setTimeout(()=>{flood.classList.remove("flooding","retreat");deleteFinalConfirm.hidden=false;document.getElementById("deleteFinalWord").focus();},11100));
}
async function waitForCloudIdle(maxWait=12000){const until=Date.now()+maxWait;while(syncingCloud&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));return !syncingCloud;}
async function rotateRevokedSessionOnThisDevice(oldToken, message="This session was deleted on another device"){
  if(getSessionToken()!==oldToken)return;
  try{clearTimeout(cloudTimer);if(realtimeChannel){try{await sb.removeChannel(realtimeChannel)}catch(e){}}}catch(e){}
  realtimeChannel=null;realtimeToken=null;cloudReady=false;
  const newToken=randomToken();state={tasks:[]};selectedTaskIds.clear();undoStack.length=0;redoStack.length=0;
  localStorage.setItem(STORAGE,JSON.stringify(state));localStorage.setItem(DRAFT_KEY,"");localStorage.setItem(SESSION_KEY,newToken);
  setDraftValue("");lastSavedSnapshot=JSON.stringify(state);setDraftValue("");
  render();
  const tokenField=document.getElementById("sessionToken");if(tokenField)tokenField.value=newToken;
  try{await waitForCloudIdle();await setupRealtime(newToken);cloudReady=true;const ok=await pushCloud(newToken);updateCloudStatus(ok?"Cloud: connected · fresh session created":"Cloud: fresh session created locally · cloud save pending");if(!ok)setTimeout(()=>pushCloud(newToken),1200);}
  catch(e){updateCloudStatus("Cloud: fresh local session · sync unavailable");}
  toast(message+" · fresh token created");
}
async function permanentlyDeleteCurrentSession(){
  const button=document.getElementById("executeFinalDelete"),status=document.getElementById("deleteFinalStatus");
  const oldToken=getSessionToken();button.disabled=true;status.textContent="Deleting the encrypted session from Supabase…";
  try{
    await ensureSupabase();
    const {data,error}=await sb.rpc("daily_sort_delete_session",{p_token:oldToken});
    if(error)throw error;
    if(realtimeChannel){try{await realtimeChannel.send({type:"broadcast",event:"deleted",payload:{at:Date.now()}})}catch(e){}try{await sb.removeChannel(realtimeChannel)}catch(e){}}
    realtimeChannel=null;realtimeToken=null;clearTimeout(cloudTimer);cloudReady=false;
    await waitForCloudIdle();
    const freshToken=randomToken();state={tasks:[]};selectedTaskIds.clear();undoStack.length=0;redoStack.length=0;
    localStorage.setItem(STORAGE,JSON.stringify(state));localStorage.setItem(DRAFT_KEY,"");localStorage.setItem(SESSION_KEY,freshToken);
    setDraftValue("");lastSavedSnapshot=JSON.stringify(state);render();
    const tokenField=document.getElementById("sessionToken");if(tokenField)tokenField.value=freshToken;
    const importField=document.getElementById("sessionImportToken");if(importField)importField.value="";
    await setupRealtime(freshToken);cloudReady=true;
    const saved=await pushCloud(freshToken);
    if(!saved)setTimeout(()=>pushCloud(freshToken),1200);
    updateCloudStatus(saved?"Cloud: connected · previous session deleted, fresh session ready":"Cloud: old session deleted · new token created locally; cloud save pending");
    deleteFinalConfirm.hidden=true;deletePrankOverlay.hidden=true;toast(saved?"Session deleted. Fresh token created.":"Old session deleted. Fresh local token created; cloud save pending.");
    if(document.getElementById("sessionModal").classList.contains("show"))document.getElementById("sessionToken").value=freshToken;
  }catch(error){
    console.error("Daily Sort account deletion failed",error);
    button.disabled=false;
    const detail=String(error?.message||error);
    status.textContent=/daily_sort_delete_session|function .* does not exist|schema cache/i.test(detail)
      ?"Deletion is not configured yet. Run supabase/delete-account.sql in the Supabase SQL Editor, then retry. Nothing was deleted."
      :"Deletion failed: "+detail+". Your existing token and data were left unchanged.";
  }
}
document.getElementById("deleteAccountPrank").onclick=beginDeletePrank;
document.getElementById("prankConfirmDelete").onclick=showFinalDeleteConfirmation;
document.getElementById("deleteFinalWord").addEventListener("input",e=>{document.getElementById("executeFinalDelete").disabled=e.target.value.trim()!=="DELETE";});
document.getElementById("executeFinalDelete").onclick=permanentlyDeleteCurrentSession;
document.getElementById("cancelFinalDelete").onclick=closeDeletePrank;
document.getElementById("prankOops").onclick=()=>{deletePrankDialog.hidden=true;deletePrankRain.hidden=true;kissScreen.hidden=false;};
document.getElementById("closeDeletePrank").onclick=closeDeletePrank;
document.getElementById("closeKiss").onclick=closeDeletePrank;
deletePrankOverlay.addEventListener("click",e=>{if(e.target===deletePrankOverlay)closeDeletePrank();});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!deletePrankOverlay.hidden)closeDeletePrank();});

const warning=document.getElementById("newSessionWarning");
document.getElementById("newToken").onclick=()=>{warning.hidden=false};
document.getElementById("cancelNewSession").onclick=()=>{warning.hidden=true};
document.getElementById("confirmNewSession").onclick=async()=>{
  const oldToken=getSessionToken();
  const newToken=randomToken();
  warning.hidden=true;
  state={tasks:[]};
  localStorage.setItem(STORAGE,JSON.stringify(state));
  localStorage.removeItem(DRAFT_KEY);
  document.getElementById("bulkInput").value="";
  localStorage.setItem(DRAFT_KEY,"");
  const draftStatus=document.getElementById("draftStatus");
  if(draftStatus)draftStatus.textContent="Draft autosave is on";
  localStorage.setItem(SESSION_KEY,newToken);
  await setupRealtime(newToken);
  localStorage.setItem(THEME_KEY,"Paper");
  applyTheme("Paper",false);
  document.getElementById("sessionToken").value=newToken;
  render();
  cloudReady=false;
  const ok=await pushCloud(newToken);
  cloudReady=ok;
  updateCloudStatus(ok?"Cloud: connected — new session created":"Cloud: unavailable — new session kept locally");
  toast(ok?"New session created":"New session created locally");
};
document.getElementById("connectToken").onclick=async()=>{
  const input=document.getElementById("sessionImportToken").value.trim();
  if(!input){toast("Paste a session token first");return;}
  const previousToken=getSessionToken();
  const ok=await pullCloud(input);
  if(ok){
    localStorage.setItem(SESSION_KEY,input);
    await setupRealtime(input);
    document.getElementById("sessionToken").value=input;
    cloudReady=true;
    updateCloudStatus("Cloud: connected — imported session");
  }else{
    localStorage.setItem(SESSION_KEY,previousToken);
    document.getElementById("sessionToken").value=previousToken;
    updateCloudStatus("Cloud: unavailable — current session preserved");
  }
};

const showTaskNumbers=document.getElementById("showTaskNumbers");
showTaskNumbers.checked=localStorage.getItem("daily-sort-show-task-numbers")==="1";
document.body.classList.toggle("show-task-numbers",showTaskNumbers.checked);
showTaskNumbers.addEventListener("change",()=>{
  document.body.classList.toggle("show-task-numbers",showTaskNumbers.checked);
  localStorage.setItem("daily-sort-show-task-numbers",showTaskNumbers.checked?"1":"0");
});
const arrangeToggle=document.getElementById("toggleArrange");
const arrangePanel=document.getElementById("arrangeTools");
arrangePanel.hidden=true;
arrangeToggle.setAttribute("aria-expanded","false");
arrangeToggle.onclick=()=>{
  const panel=arrangePanel;
  const opening=panel.hidden;panel.hidden=!opening;
  document.getElementById("toggleArrange").setAttribute("aria-expanded",opening?"true":"false");
  document.getElementById("toggleArrange").textContent=opening?"↕ Close arrange":"↕ Arrange";
  updateSelectionCount();
};
function setHeightMode(dynamic, persist=true){
  const enabled=!!dynamic;
  document.body.classList.toggle("dynamic-panels",enabled);
  document.body.dataset.panelHeight=enabled?"dynamic":"fixed";
  const control=document.getElementById("togglePanelHeight");
  if(control){control.classList.toggle("is-dynamic",enabled);control.setAttribute("aria-pressed",enabled?"true":"false");control.dataset.mode=enabled?"dynamic":"fixed";}
  const label=document.getElementById("heightModeLabel");
  if(label)label.textContent=enabled?"Dynamic":"Fixed";
  document.querySelectorAll(".panel").forEach(panel=>{
    const cards=panel.querySelector(".cards");
    panel.style.display="flex";
    panel.style.flexDirection="column";
    panel.style.minHeight="0";
    if(enabled){
      panel.style.height="auto";
      panel.style.minHeight="0";
      panel.style.maxHeight="none";
      panel.style.overflow="visible";
      if(cards){
        cards.style.height="auto";
        cards.style.minHeight="0";
        cards.style.maxHeight="none";
        cards.style.flex="0 0 auto";
        cards.style.overflowY="visible";
        cards.style.overscrollBehavior="auto";
      }
    }else{
      const compact=window.matchMedia("(max-width: 700px) and (orientation: portrait)").matches;
      const available=Math.max(300,window.innerHeight-(compact?250:245));
      panel.style.height=available+"px";
      panel.style.minHeight="0";
      panel.style.maxHeight=available+"px";
      panel.style.overflow="hidden";
      if(cards){
        cards.style.height="0";
        cards.style.minHeight="0";
        cards.style.maxHeight="none";
        cards.style.flex="1 1 auto";
        cards.style.overflowY="auto";
        cards.style.overscrollBehavior="contain";
      }
    }
  });
  if(persist)try{localStorage.setItem("daily-sort-panel-height",enabled?"dynamic":"fixed")}catch(e){}
  requestAnimationFrame(()=>window.dispatchEvent(new Event("resize")));
}
document.getElementById("togglePanelHeight").addEventListener("click",e=>{e.preventDefault();e.stopPropagation();setHeightMode(document.body.dataset.panelHeight!=="dynamic");});
window.addEventListener("resize",()=>{
  const dynamic=document.body.dataset.panelHeight==="dynamic";
  if(dynamic){
    document.querySelectorAll(".panel").forEach(panel=>{
      panel.style.height="auto";
      panel.style.maxHeight="none";
      panel.style.overflow="visible";
      const cards=panel.querySelector(".cards");
      if(cards){cards.style.height="auto";cards.style.maxHeight="none";cards.style.flex="0 0 auto";cards.style.overflowY="visible";}
    });
    return;
  }
  const compact=window.matchMedia("(max-width: 700px) and (orientation: portrait)").matches;
  const available=Math.max(300,window.innerHeight-(compact?250:245));
  document.querySelectorAll(".panel").forEach(panel=>{
    panel.style.height=available+"px";panel.style.maxHeight=available+"px";
    const cards=panel.querySelector(".cards");
    if(cards){cards.style.height="0";cards.style.flex="1 1 auto";cards.style.overflowY="auto";}
  });
});
setHeightMode(localStorage.getItem("daily-sort-panel-height")==="dynamic",false);
document.getElementById("clearSelection").onclick=()=>{
  selectedTaskIds.clear();
  document.querySelectorAll('[data-action="select-task"]').forEach(box=>{box.checked=false;});
  document.querySelectorAll(".card.selected").forEach(card=>card.classList.remove("selected"));
  updateSelectionCount();
};
document.getElementById("moveSelected").onclick=moveSelectedAbove;
document.getElementById("moveTargetZone").addEventListener("change",updateMoveRange);
document.getElementById("moveAboveNumber").addEventListener("input",updateMoveRange);
document.getElementById("undoAction").onclick=undoLastAction;
document.getElementById("redoAction").onclick=redoLastAction;
document.getElementById("applySelectedColor").onclick=applyColorToSelected;
document.getElementById("removeSelectedColor").onclick=removeColorFromSelected;

load();
lastSavedSnapshot=JSON.stringify(state);
initDrafts();
applyTheme(localStorage.getItem(THEME_KEY)||"Paper",false);
render();
const bootSessionToken=getSessionToken();
const tokenField=document.getElementById("sessionToken");
if(tokenField)tokenField.value=bootSessionToken;
(async()=>{
  const field=document.getElementById("sessionToken");
  if(field)field.value=bootSessionToken;
  try{
    await ensureSupabase();
    const results=await Promise.allSettled([
      setupRealtime(bootSessionToken),
      pullCloud(bootSessionToken)
    ]);
    const failure=results.find(x=>x.status==="rejected");
    if(failure)throw failure.reason;
    if(field)field.value=localStorage.getItem(SESSION_KEY)||bootSessionToken;
  }catch(err){
    console.error("Daily Sort cloud startup failed",err);
    updateCloudStatus("Cloud: unavailable · local tasks remain available · "+(err?.message||"connection failed"));
    if(field)field.value=localStorage.getItem(SESSION_KEY)||bootSessionToken;
  }
})();

const UTC_OFFSETS=[
  ["-12:00","Baker Island, Howland Island"],["-11:00","American Samoa, Niue"],["-10:00","Hawaii, United States"],
  ["-09:30","Marquesas Islands"],["-09:00","Gambier Islands"],["-07:00","Northeastern British Columbia, Sonora, Arizona"],
  ["-06:00","Saskatchewan, Costa Rica, El Salvador, Galápagos, Guatemala, Honduras, Mexico, Nicaragua"],
  ["-05:00","Colombia, Cuba, Ecuador, Jamaica, Panama, Peru"],["-04:30","Venezuela"],
  ["-04:00","Bolivia, Amazonas, continental Chile, Dominican Republic, Nova Scotia, Puerto Rico, Barbados, Trinidad and Tobago"],
  ["-03:00","Argentina, Paraguay"],["-02:00","Fernando de Noronha, South Georgia and the South Sandwich Islands"],
  ["-01:00","Cape Verde"],["+00:00","Côte d'Ivoire, Faroe Islands, Ghana, Iceland, Senegal"],
  ["+01:00","Algeria, Angola, Benin, Cameroon, Gabon, Niger, Nigeria, western DR Congo, Tunisia"],
  ["+02:00","Egypt, Malawi, Mozambique, South Africa, Swaziland, Zambia, Zimbabwe"],
  ["+03:00","Belarus, Djibouti, Eritrea, Ethiopia, Iraq, Kenya, Madagascar, Saudi Arabia, South Sudan, Sudan, Somalia, Tanzania, Uganda, Yemen"],
  ["+04:00","Armenia, Azerbaijan, Georgia, Mauritius, Oman, European Russia, Seychelles, UAE"],["+04:30","Afghanistan"],
  ["+05:00","Western Kazakhstan, Maldives, Pakistan, Uzbekistan"],["+05:30","India, Sri Lanka"],["+05:45","Kathmandu, Nepal"],
  ["+06:00","Most of Kazakhstan, Bangladesh, Bhutan, Ural Russia"],["+06:30","Cocos Islands, Myanmar"],
  ["+07:00","Western Indonesia, Novosibirsk, Thailand, Vietnam, Cambodia"],["+08:00","Hong Kong, China, Malaysia, Philippines, Singapore, Taiwan, Mongolia, Western Australia, Macau"],
  ["+08:45","Eucla, Australia (unofficial)"],["+09:00","Eastern Indonesia, Timor-Leste, Irkutsk, Japan, North Korea, South Korea"],
  ["+09:30","Northern Territory, Australia"],["+10:00","Zabaykalsky Krai, Papua New Guinea, Queensland, Australia"],
  ["+11:00","New Caledonia, Primorsky Krai, Solomon Islands"],["+11:30","Norfolk Island"],
  ["+12:00","Gilbert Islands, Fiji, Kamchatka"],["+13:00","Phoenix Islands, Tonga, Tokelau"],["+14:00","Line Islands, Kiribati"]
];
const TIME_PREF_KEY="daily-sort-time-zone-pref-v1";
let onlineUtcEpoch=0,onlineClockStarted=0,onlineClockSynced=false,clockDisplayMode="system",clockDisplayZone="UTC",clockDisplayOffset="+05:30",clockUsesWallTime=true,clockSyncPromise=null;
function offsetMinutes(value){const m=String(value).match(/^([+-])(\d{2}):(\d{2})$/);return m?(m[1]==="-"?-1:1)*(Number(m[2])*60+Number(m[3])):0;}
function clockNow(){return onlineClockSynced?onlineUtcEpoch+(performance.now()-onlineClockStarted):Date.now();}
function getClockPreference(){
  let pref={mode:"system",offset:"+05:30"};
  try{pref={...pref,...JSON.parse(localStorage.getItem(TIME_PREF_KEY)||"{}")}}catch(e){}
  return pref;
}
function formatClockDate(date,zone){
  return new Intl.DateTimeFormat("en-GB",{timeZone:zone,hour12:false,year:"numeric",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(date);
}
function renderClock(){
  const el=document.getElementById("localClock");if(!el)return;
  const now=new Date(clockNow()),pref=getClockPreference();
  try{
    if(onlineClockSynced){
      const zone=clockDisplayMode==="custom"||clockUsesWallTime?"UTC":clockDisplayZone;
      el.textContent=formatClockDate(now,zone)+" · "+(clockDisplayMode==="custom"?"UTC "+clockDisplayOffset:clockDisplayZone);
    }else if(pref.mode==="custom"){
      const shifted=new Date(now.getTime()+offsetMinutes(pref.offset||"+05:30")*60000);
      el.textContent=shifted.toISOString().slice(0,19).replace("T"," ")+" · UTC "+(pref.offset||"+05:30");
    }else{
      const zone=Intl.DateTimeFormat().resolvedOptions().timeZone||"System";
      el.textContent=formatClockDate(now,zone)+" · "+zone;
    }
  }catch(e){el.textContent=now.toLocaleString()+" · Device time";}
}
function timePayloadEpoch(data){
  const values=[data.year,data.month,data.day,data.hour,data.minute,data.seconds??data.second];
  if(values.every(v=>v!==undefined&&Number.isFinite(Number(v)))){
    return Date.UTC(Number(values[0]),Number(values[1])-1,Number(values[2]),Number(values[3]),Number(values[4]),Number(values[5]));
  }
  const raw=data.dateTime||data.currentLocalTime||data.datetime||data.utc_datetime;
  if(raw){
    const m=String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    if(m)return Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]),Number(m[5]),Number(m[6]));
    const parsed=Date.parse(raw);if(Number.isFinite(parsed))return parsed;
  }
  throw new Error("Unrecognized time response");
}
async function requestOnlineTime(zone){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),7000);
  try{
    const url="https://timeapi.io/api/time/current/zone?timeZone="+encodeURIComponent(zone);
    const response=await fetch(url,{cache:"no-store",signal:controller.signal,mode:"cors"});
    if(!response.ok)throw new Error("Time provider HTTP "+response.status);
    return timePayloadEpoch(await response.json());
  }finally{clearTimeout(timeout);}
}
async function requestFallbackTime(zone){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),7000);
  try{
    const response=await fetch("https://worldtimeapi.org/api/timezone/"+encodeURIComponent(zone),{cache:"no-store",signal:controller.signal,mode:"cors"});
    if(!response.ok)throw new Error("Fallback time provider HTTP "+response.status);
    const data=await response.json();
    if(Number.isFinite(Number(data.unixtime)))return Number(data.unixtime)*1000;
    const parsed=Date.parse(data.datetime||data.utc_datetime||"");
    if(Number.isFinite(parsed))return parsed;
    throw new Error("Unrecognized fallback time response");
  }finally{clearTimeout(timeout);}
}
async function syncOnlineClock(){
  if(clockSyncPromise)return clockSyncPromise;
  clockSyncPromise=(async()=>{
    const status=document.getElementById("timeZoneStatus");
    if(status)status.textContent="Syncing online clock…";
    const pref=getClockPreference(),custom=pref.mode==="custom";
    const zone=custom?"UTC":(Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC");
    try{
      let epoch,wall=true,displayZone=zone;
      try{epoch=await requestOnlineTime(zone);}
      catch(primaryError){
        try{epoch=await requestFallbackTime(zone);wall=false;}
        catch(fallbackError){
          if(custom)throw fallbackError;
          epoch=await requestOnlineTime("UTC");wall=false;
        }
      }
      if(custom){epoch+=offsetMinutes(pref.offset||"+05:30")*60000;wall=true;}
      onlineUtcEpoch=epoch;
      onlineClockStarted=performance.now();
      onlineClockSynced=true;
      clockDisplayMode=custom?"custom":"system";
      clockDisplayZone=custom?"UTC "+(pref.offset||"+05:30"):displayZone;
      clockDisplayOffset=pref.offset||"+05:30";
      clockUsesWallTime=wall||custom;
      if(status)status.textContent="Online clock synced · "+(custom?"UTC "+clockDisplayOffset:zone);
      renderClock();
    }catch(error){
      onlineClockSynced=false;
      if(status)status.textContent="Online clock unavailable · device clock shown";
      renderClock();
    }
  })().finally(()=>{clockSyncPromise=null;});
  return clockSyncPromise;
}
function initTimeZoneSettings(){
  const mode=document.getElementById("timeZoneMode"),offset=document.getElementById("customUtcOffset");
  if(!mode||!offset)return;
  offset.innerHTML=UTC_OFFSETS.map(([value,places])=>`<option value="${value}">UTC ${value.replace("+","+")} — ${escapeHtml(places)}</option>`).join("");
  let pref;try{pref=JSON.parse(localStorage.getItem(TIME_PREF_KEY)||"null")}catch(e){}
  if(!pref)pref={mode:"system",offset:"+05:30"};
  mode.value=pref.mode==="custom"?"custom":"system";offset.value=pref.offset||"+05:30";offset.disabled=mode.value!=="custom";
  const savePref=()=>{const p={mode:mode.value,offset:offset.value};localStorage.setItem(TIME_PREF_KEY,JSON.stringify(p));offset.disabled=mode.value!=="custom";syncOnlineClock();};
  mode.addEventListener("change",savePref);offset.addEventListener("change",savePref);
}
initTimeZoneSettings();
renderClock();
syncOnlineClock();
setInterval(renderClock,1000);
setInterval(syncOnlineClock,15*60*1000);
let lastClockVisibilitySync=0;
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&Date.now()-lastClockVisibilitySync>30000){lastClockVisibilitySync=Date.now();syncOnlineClock();}});
window.addEventListener("pageshow",()=>syncOnlineClock());
window.addEventListener("online",()=>syncOnlineClock());
