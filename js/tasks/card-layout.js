/* v41: classify cards by actual rendered line count, not character count. */
(function(){
  function classifyCard(card){
    const editor=card.querySelector('.task-title-edit');
    const body=card.querySelector('.task-body');
    if(!body) return;
    let multiline=false;
    if(editor){
      const style=getComputedStyle(editor);
      const lineHeight=parseFloat(style.lineHeight)||22;
      const text=editor.value||'';
      const explicitLines=(text.match(/\n/g)||[]).length+1;
      const renderedLines=Math.max(explicitLines,Math.round((editor.scrollHeight-parseFloat(style.paddingTop||0)-parseFloat(style.paddingBottom||0))/lineHeight));
      multiline=renderedLines>1;
    } else {
      multiline=!!card.querySelector('.toggle-list-heading') && !card.querySelector('.toggle-list-collapse[aria-expanded="false"]');
    }
    card.classList.toggle('is-multiline',multiline);
    card.classList.toggle('is-single-line',!multiline);
  }
  function scan(root){
    (root||document).querySelectorAll('.card').forEach(classifyCard);
  }
  document.addEventListener('input',e=>{
    if(e.target.matches('.task-title-edit')) classifyCard(e.target.closest('.card'));
  },true);
  document.addEventListener('click',e=>{
    if(e.target.closest('[data-action="expand"],[data-action="toggle-list-collapse"]')){
      requestAnimationFrame(()=>scan(document));
    }
  },true);
  const observer=new MutationObserver(()=>scan(document));
  function start(){
    scan(document);
    const board=document.querySelector('.board')||document.body;
    observer.observe(board,{childList:true,subtree:true});
    window.addEventListener('resize',()=>scan(document),{passive:true});
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();
