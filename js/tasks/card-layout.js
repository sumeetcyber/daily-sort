(function(){
  function classifyCard(card){
    const editor=card.querySelector('.task-title-edit');if(!editor)return;
    const text=editor.querySelector('[data-task-text]');
    const value=(text?.innerText||text?.textContent||'').trim();
    let lines=(value.match(/\n/g)||[]).length+1;
    if(text&&value){const range=document.createRange();range.selectNodeContents(text);const rects=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0);lines=Math.max(lines,rects.length);}
    card.classList.toggle('is-multiline',lines>1);card.classList.toggle('is-single-line',lines<=1);
  }
  function scan(root){(root||document).querySelectorAll('.card').forEach(classifyCard);}
  document.addEventListener('input',e=>{if(e.target.matches('.task-title-edit'))classifyCard(e.target.closest('.card'));},true);
  document.addEventListener('click',e=>{if(e.target.closest('[data-action="expand"],[data-action="toggle-list-collapse"]'))requestAnimationFrame(()=>scan(document));},true);
  const observer=new MutationObserver(()=>scan(document));
  function start(){scan(document);observer.observe(document.querySelector('.board')||document.body,{childList:true,subtree:true});window.addEventListener('resize',()=>scan(document),{passive:true});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
