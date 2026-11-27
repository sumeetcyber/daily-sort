
if("serviceWorker" in navigator && location.protocol==="https:"){
  const DS_SW_BUILD="2026-11-27-v57";
  let dsRegistration=null,dsLastFreshCheck=0;
  let dsHadController=!!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange",()=>{
    if(!dsHadController){dsHadController=true;return;}
    const key="daily-sort-reloaded-"+DS_SW_BUILD;
    if(!sessionStorage.getItem(key)){sessionStorage.setItem(key,"1");location.reload();}
  });
  async function checkDailySortCache(force=false){
    if(document.visibilityState==="hidden")return;
    if(!force&&Date.now()-dsLastFreshCheck<30000)return;
    dsLastFreshCheck=Date.now();
    try{
      if(!dsRegistration)dsRegistration=await navigator.serviceWorker.register("./sw.js?build="+DS_SW_BUILD,{scope:"./",updateViaCache:"none"});
      await dsRegistration.update();
      if(dsRegistration.waiting)dsRegistration.waiting.postMessage({type:"SKIP_WAITING"});
    }catch(error){console.debug("Daily Sort cache check skipped",error);}
  }
  window.addEventListener("load",()=>checkDailySortCache(true));
  window.addEventListener("pageshow",()=>checkDailySortCache());
  window.addEventListener("focus",()=>checkDailySortCache());
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")checkDailySortCache(true);});
}
function fitLandscapeBoard(){
  const mq=window.matchMedia("(max-width: 900px) and (orientation: landscape)");
  if(!mq.matches || document.body.classList.contains("dynamic-panels"))return;
  const board=document.querySelector(".board");if(!board)return;
  const top=board.getBoundingClientRect().top;
  const gap=Math.max(34,Math.min(64,window.innerHeight*.065));
  const height=Math.max(220,window.innerHeight-top-gap);
  document.querySelectorAll(".board>.panel").forEach(panel=>{
    panel.style.setProperty("height",height+"px","important");
    panel.style.setProperty("min-height","0px","important");
    panel.style.setProperty("max-height","none","important");
  });
}
let landscapeFitFrame=0;
function scheduleLandscapeFit(){cancelAnimationFrame(landscapeFitFrame);landscapeFitFrame=requestAnimationFrame(()=>requestAnimationFrame(fitLandscapeBoard));}
window.addEventListener("resize",scheduleLandscapeFit,{passive:true});window.addEventListener("orientationchange",()=>setTimeout(scheduleLandscapeFit,160),{passive:true});
if(window.visualViewport)window.visualViewport.addEventListener("resize",scheduleLandscapeFit,{passive:true});
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")scheduleLandscapeFit();});
setTimeout(scheduleLandscapeFit,80);
