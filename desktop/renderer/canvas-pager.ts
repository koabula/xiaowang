/** The same protocol is used by generated decks and adapters for older HTML materials. */
export const CANVAS_PAGER_SHIM = `<script data-xw-pager>(function(){
var last=1, revision=0, lastReport="", requested=null, reporting=false;
var activeClasses=["active","current","present","on"];
function slides(){
 var selectors=["[data-xw-slide]",".reveal .slides > section","section.slide","[data-slide]",".slide",".s","main > section","body > section","article > section"];
 for(var i=0;i<selectors.length;i++){var list=document.querySelectorAll(selectors[i]);if(list.length)return Array.from(list);}
 return [document.body];
}
function api(){var value=window.xiaowangSlides;return value&&typeof value.goToPage==="function"&&typeof value.getState==="function"?value:null;}
function state(){
 var custom=api();if(custom){var s=custom.getState();return {page:Number(s.page),totalPages:Number(s.totalPages),title:document.title};}
 var list=slides(),current=last;
 for(var i=0;i<list.length;i++)if(activeClasses.some(function(c){return list[i].classList.contains(c);})){current=i+1;break;}
 return {page:current,totalPages:list.length,title:document.title};
}
function visible(el){
 if(!el)return false;var cs=getComputedStyle(el),r=el.getBoundingClientRect();
 if(cs.display==="none"||cs.visibility==="hidden"||Number(cs.opacity)===0)return false;
 if(r.width>0&&r.height>0)return true;
 // Absolutely positioned pages can be visible while their body has zero height.
 return el===document.body&&Array.from(el.children).some(function(child){var c=getComputedStyle(child),box=child.getBoundingClientRect();return c.display!=="none"&&c.visibility!=="hidden"&&Number(c.opacity)!==0&&box.width>0&&box.height>0;});
}
function report(id,error){
 var s=state();s.type="xiaowang:position";s.requestId=id||"";s.error=error||"";
 var key=JSON.stringify(s);if(key===lastReport)return;lastReport=key;parent.postMessage(s,"*");
}
function flip(page,id){
 var rev=++revision,n=Number(page),list=slides(),custom=api(),count=custom?Number(custom.getState().totalPages):list.length;
 requested={page:n,id:id||""};
 if(!Number.isInteger(n)||n<1||n>count){report(id,"请求页码超出材料范围");return;}
 last=n;
 try{
  if(custom)custom.goToPage(n);
  else if(window.Reveal&&typeof window.Reveal.slide==="function"){
   if(typeof window.Reveal.isReady==="function"&&!window.Reveal.isReady()){setTimeout(function(){if(rev===revision)flip(n,id);},40);return;}
   window.Reveal.slide(n-1);
  }else if(list.every(function(el){return el.classList.contains("s");})&&typeof window.go==="function"){
   var current=list.findIndex(function(el){return el.classList.contains("on");});window.go(n-1-Math.max(0,current));
  }else{
   var chosen=list[n-1],tokens=activeClasses.filter(function(c){return list.some(function(el){return el.classList.contains(c);});});
   var hidden=list.some(function(el){return getComputedStyle(el).display==="none";});
   var display=list.map(function(el){return getComputedStyle(el).display;}).find(function(value){return value!=="none";})||chosen.getAttribute("data-xw-display")||"block";
   if(hidden||tokens.length||list.some(function(el){return el.matches(".slide,[data-xw-slide],[data-slide],.s");}))list.forEach(function(el,i){
    tokens.forEach(function(c){el.classList.toggle(c,i===n-1);});
    if(!tokens.length)el.classList.toggle("active",i===n-1);
    el.setAttribute("aria-hidden",String(i!==n-1));
    if(i!==n-1)el.style.display="none";else{el.style.removeProperty("display");if(getComputedStyle(el).display==="none")el.style.display=display;}
   });
   chosen.scrollIntoView({block:"start",behavior:"instant"});
  }
  var started=performance.now(),stable=0;
  function check(){
   if(rev!==revision)return;
   var target=slides()[n-1],s=state();
   if(visible(target)&&s.page===n)stable++;else stable=0;
   if(stable>=2){report(id);return;}
   if(performance.now()-started>3000){report(id,"指定页面未能显示");return;}
   requestAnimationFrame(check);
  }
  requestAnimationFrame(check);
 }catch(e){report(id,String(e));}
}
window.addEventListener("message",function(e){if(e.source===parent&&e.data&&e.data.type==="xiaowang:page")flip(e.data.page,e.data.requestId);});
function changed(){if(reporting)return;reporting=true;requestAnimationFrame(function(){reporting=false;if(requested&&state().page===requested.page&&visible(slides()[requested.page-1]))report(requested.id);else report();});}
function ready(){
 new MutationObserver(changed).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:["class","style","hidden"]});
 window.addEventListener("keydown",function(){setTimeout(changed,0);});window.addEventListener("click",function(){setTimeout(changed,0);});
 parent.postMessage({type:"xiaowang:ready"},"*");
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ready,{once:true});else ready();
})();</script>`;
export function withCanvasPager(html: string): string {
  if (html.includes("data-xw-pager")) return html;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${CANVAS_PAGER_SHIM}</body>`) : `${html}${CANVAS_PAGER_SHIM}`;
}
